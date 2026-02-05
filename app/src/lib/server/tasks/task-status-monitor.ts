/**
 * Task Status Monitoring Service
 *
 * Background service that monitors all active tasks, analyzes their terminal output using
 * Anthropic SDK, suggests next actions, and can autonomously continue agents if needed.
 *
 * Features:
 * - Monitors ALL active tasks (not just Linear tasks)
 * - Uses SSH/tmux to capture terminal snapshots
 * - AI-powered status analysis using Claude
 * - Suggests next actions based on terminal state
 * - Can autonomously continue agents when appropriate
 * - Stores analysis results in task metadata for dashboard display
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import {
	getAllTasks,
	getTaskById,
	updateTaskMetadata,
	type Task,
	type TaskMetadata,
} from '../db';
import { getAnthropicApiKey } from '../secrets';
import { readTerminalFile } from '../terminal-storage';
import {
	getActiveConnection,
	hasActiveConnection,
	getConnectionInfo,
	sendInstruction,
} from '../vm/orchestrator';

/**
 * Analysis result from AI
 */
export interface TaskAnalysis {
	state: 'agent_idle_waiting' | 'agent_working' | 'agent_needs_input' | 'agent_stuck' | 'agent_completed';
	reasoning: string;
	summary: string;
	suggestedActions: string[];
	confidence: number; // 0-100
	timestamp: string;
	terminalSnapshot: string; // Last 100 lines for reference
}

/**
 * Extended task metadata with monitoring info
 */
interface TaskMonitoringMetadata {
	monitoring?: {
		last_analysis?: TaskAnalysis;
		last_check_timestamp?: string;
		auto_continue_count?: number;
	};
}

/**
 * Task Status Monitor - Background service
 */
export class TaskStatusMonitor {
	private isRunning: boolean = false;
	private pollIntervalMs: number;
	private anthropicClient: Anthropic | null = null;
	private initPromise: Promise<void> | null = null;

	constructor() {
		// Default: check every 60 seconds
		this.pollIntervalMs = parseInt(env.TASK_MONITOR_POLL_INTERVAL_MS || '60000', 10);
	}

	/**
	 * Initialize the monitor by resolving API key
	 */
	private async initialize(): Promise<void> {
		if (this.anthropicClient) return;

		if (!this.initPromise) {
			this.initPromise = (async () => {
				const apiKey = await getAnthropicApiKey();
				this.anthropicClient = new Anthropic({ apiKey });
			})();
		}

		await this.initPromise;
	}

	/**
	 * Start the monitoring service
	 */
	async start(): Promise<void> {
		console.log('[TaskStatusMonitor] Starting monitor...');
		console.log(`[TaskStatusMonitor] Poll interval: ${this.pollIntervalMs}ms`);

		await this.initialize();
		this.isRunning = true;
		await this.poll();
	}

	/**
	 * Stop the monitoring service
	 */
	async stop(): Promise<void> {
		console.log('[TaskStatusMonitor] Stopping monitor...');
		this.isRunning = false;
	}

	/**
	 * Main polling loop
	 */
	private async poll(): Promise<void> {
		while (this.isRunning) {
			try {
				await this.checkAllActiveTasks();
			} catch (error) {
				console.error('[TaskStatusMonitor] Error during poll:', error);
			}

			// Wait for next poll
			await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
		}
	}

	/**
	 * Check all active tasks for status updates
	 */
	private async checkAllActiveTasks(): Promise<void> {
		// Get all active tasks (running, cloning, initializing)
		const allTasks = await getAllTasks();
		const activeTasks = allTasks.filter((task) =>
			['running', 'cloning', 'initializing'].includes(task.status)
		);

		console.log(`[TaskStatusMonitor] Checking ${activeTasks.length} active tasks`);

		for (const task of activeTasks) {
			try {
				await this.analyzeTask(task);
			} catch (error) {
				console.error(
					`[TaskStatusMonitor] Error analyzing task ${task.id}:`,
					error
				);
			}
		}
	}

	/**
	 * Analyze a single task
	 */
	private async analyzeTask(task: Task): Promise<void> {
		// Check if we should analyze this task
		const metadata = task.metadata as TaskMonitoringMetadata | null;
		const lastCheck = metadata?.monitoring?.last_check_timestamp;

		// Skip if checked less than 5 minutes ago
		if (lastCheck) {
			const timeSinceCheck = Date.now() - new Date(lastCheck).getTime();
			if (timeSinceCheck < 5 * 60 * 1000) {
				return;
			}
		}

		// Only analyze tasks with "running" status
		if (task.status !== 'running') {
			return;
		}

		console.log(`[TaskStatusMonitor] Analyzing task ${task.id}`);

		// Check SSH connection status
		const connInfo = getConnectionInfo(task.id);
		if (!connInfo.hasConnection || connInfo.status !== 'connected') {
			console.log(
				`[TaskStatusMonitor] Task ${task.id} has no active SSH connection (status: ${connInfo.status || 'none'}), skipping analysis`
			);
			return;
		}

		// Capture terminal output from SSH connection
		// The terminal file is populated in real-time by the SSH connection
		const terminalOutput = readTerminalFile(task.id, 200);

		if (!terminalOutput || terminalOutput.trim().length === 0) {
			console.log(
				`[TaskStatusMonitor] No terminal output captured yet for task ${task.id}, skipping analysis`
			);
			return;
		}

		console.log(
			`[TaskStatusMonitor] Captured ${terminalOutput.split('\n').length} lines via SSH connection for task ${task.id} (last activity: ${connInfo.lastActivity?.toISOString()})`
		);

		// Analyze with Claude
		const analysis = await this.analyzeTerminalOutput(
			terminalOutput,
			task.task_description
		);

		console.log(
			`[TaskStatusMonitor] Analysis for ${task.id}: ${analysis.state} (confidence: ${analysis.confidence}%)`
		);

		// Store analysis in task metadata
		await this.storeAnalysis(task.id, analysis);

		// Take action if needed
		await this.handleAnalysisResult(task, analysis);
	}

	/**
	 * Analyze terminal output using Claude
	 */
	private async analyzeTerminalOutput(
		terminalOutput: string,
		taskDescription: string
	): Promise<TaskAnalysis> {
		if (!this.anthropicClient) {
			throw new Error('Anthropic client not initialized');
		}

		// Get last 100 lines for snapshot
		const lines = terminalOutput.split('\n');
		const terminalSnapshot = lines.slice(-100).join('\n');

		const prompt = `You are an expert at analyzing autonomous coding agent terminal output to determine the agent's current state and suggest next actions.

## Task Description
${taskDescription}

## Terminal Output (last section)
\`\`\`
${terminalOutput}
\`\`\`

## Your Task
Analyze the terminal output and classify the agent's current state. Also provide actionable suggestions.

### State Categories:
1. **agent_idle_waiting**: Agent completed its work and is idle, waiting for review or next instruction
   - Look for: MR/PR created, "waiting for review", no active processes, idle prompt

2. **agent_working**: Agent is actively working on the task
   - Look for: Recent command outputs, file operations, builds running, active processes

3. **agent_needs_input**: Agent is blocked and explicitly needs user input
   - Look for: Questions, prompts asking for decisions, clarification requests

4. **agent_stuck**: Agent appears to be stuck or in an error state
   - Look for: Repeated errors, failing commands, infinite loops, no progress for extended time

5. **agent_completed**: Agent has fully completed the task with deliverable
   - Look for: MR/PR created, tests passing, explicit completion messages

### Suggested Actions:
Based on the state, suggest 1-3 concrete actions that could help:
- For idle: "Review the merge request at [URL]"
- For stuck: "Restart with clearer instructions", "Check error logs"
- For needs_input: "Provide the requested information: [specific question]"
- For working: "Wait for current operation to complete"

## Output Format
Respond with a JSON object:
{
  "state": "agent_idle_waiting" | "agent_working" | "agent_needs_input" | "agent_stuck" | "agent_completed",
  "reasoning": "Brief explanation (1-2 sentences) of why you chose this state",
  "summary": "One sentence summary of what the agent is currently doing or has accomplished",
  "suggestedActions": ["Action 1", "Action 2", "Action 3"],
  "confidence": 85,  // 0-100, how confident you are in this assessment
  "canAutoContinue": false  // true if agent can be automatically prompted to continue
}

### Auto-Continue Guidelines:
Set canAutoContinue to true ONLY if:
- Agent is idle but the task is clearly incomplete (no MR created yet)
- Agent is stuck on a simple error that can be fixed with a generic "please fix this" prompt
- Agent needs a gentle nudge to proceed (e.g., "continue with next step")

DO NOT auto-continue if:
- Agent needs specific user input or decisions
- Agent has created an MR and is waiting for review
- Agent is actively working (working state)

IMPORTANT:
- Default to "agent_working" if uncertain
- Only mark as "agent_completed" if there's clear evidence of deliverables (MR/PR URL, completion message)
- Be conservative with canAutoContinue - when in doubt, set it to false`;

		try {
			const response = await this.anthropicClient.messages.create({
				model: 'claude-sonnet-4-5-20250929',
				max_tokens: 1024,
				messages: [
					{
						role: 'user',
						content: prompt,
					},
				],
			});

			// Extract the text response
			const textContent = response.content.find((block) => block.type === 'text');
			if (!textContent || textContent.type !== 'text') {
				throw new Error('No text content in Claude response');
			}

			// Parse the JSON response
			const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				throw new Error('No JSON found in Claude response');
			}

			const result = JSON.parse(jsonMatch[0]) as {
				state: TaskAnalysis['state'];
				reasoning: string;
				summary: string;
				suggestedActions: string[];
				confidence: number;
				canAutoContinue?: boolean;
			};

			// Validate the result
			const validStates = [
				'agent_idle_waiting',
				'agent_working',
				'agent_needs_input',
				'agent_stuck',
				'agent_completed',
			];
			if (!validStates.includes(result.state)) {
				throw new Error(`Invalid state: ${result.state}`);
			}

			return {
				state: result.state,
				reasoning: result.reasoning,
				summary: result.summary,
				suggestedActions: result.suggestedActions || [],
				confidence: result.confidence || 50,
				timestamp: new Date().toISOString(),
				terminalSnapshot,
			};
		} catch (error) {
			console.error('[TaskStatusMonitor] Error analyzing terminal output:', error);
			// Return default "working" state on error
			return {
				state: 'agent_working',
				reasoning: `Analysis failed: ${error instanceof Error ? error.message : String(error)}`,
				summary: 'Unable to determine current state',
				suggestedActions: ['Check terminal output manually'],
				confidence: 0,
				timestamp: new Date().toISOString(),
				terminalSnapshot,
			};
		}
	}

	/**
	 * Store analysis in task metadata
	 */
	private async storeAnalysis(taskId: string, analysis: TaskAnalysis): Promise<void> {
		await updateTaskMetadata(taskId, {
			monitoring: {
				last_analysis: analysis,
				last_check_timestamp: new Date().toISOString(),
			},
		});
	}

	/**
	 * Handle analysis result - take action if needed
	 */
	private async handleAnalysisResult(task: Task, analysis: TaskAnalysis): Promise<void> {
		// For now, just log the analysis
		// In the future, this could:
		// - Send notifications
		// - Update Linear tickets
		// - Automatically continue agents
		// - Trigger alerts for stuck agents

		console.log(`[TaskStatusMonitor] Task ${task.id} analysis:`, {
			state: analysis.state,
			summary: analysis.summary,
			confidence: analysis.confidence,
		});

		// Example: Auto-continue for idle agents (if confidence is high)
		// This is disabled by default - uncomment to enable
		/*
		if (
			analysis.state === 'agent_idle_waiting' &&
			analysis.confidence > 70 &&
			analysis.suggestedActions.some((action) => action.includes('continue'))
		) {
			const metadata = task.metadata as TaskMonitoringMetadata | null;
			const autoContinueCount = metadata?.monitoring?.auto_continue_count || 0;

			// Limit auto-continues to prevent infinite loops
			if (autoContinueCount < 2) {
				console.log(`[TaskStatusMonitor] Auto-continuing task ${task.id}`);
				await this.autoContinueAgent(task, analysis);
			}
		}
		*/
	}

	/**
	 * Automatically continue an agent with a gentle prompt
	 */
	async autoContinueAgent(task: Task, analysis: TaskAnalysis): Promise<boolean> {
		try {
			// Check if we have an active connection
			const conn = getActiveConnection(task.id);
			if (!conn) {
				console.log(
					`[TaskStatusMonitor] Cannot auto-continue ${task.id}: no active connection`
				);
				return false;
			}

			// Update auto-continue count
			const metadata = task.metadata as TaskMonitoringMetadata | null;
			const autoContinueCount = (metadata?.monitoring?.auto_continue_count || 0) + 1;

			await updateTaskMetadata(task.id, {
				monitoring: {
					...metadata?.monitoring,
					auto_continue_count: autoContinueCount,
				},
			});

			// Send a gentle prompt to continue
			const continuePrompt =
				'Please continue working on the task. If you have completed it, create a merge request.';

			console.log(`[TaskStatusMonitor] Sending continue prompt to task ${task.id}`);
			await sendInstruction(task.id, continuePrompt);

			return true;
		} catch (error) {
			console.error(
				`[TaskStatusMonitor] Error auto-continuing task ${task.id}:`,
				error
			);
			return false;
		}
	}

	/**
	 * Manually trigger analysis for a specific task
	 */
	async analyzeTaskNow(taskId: string): Promise<TaskAnalysis | null> {
		const task = await getTaskById(taskId);
		if (!task) {
			throw new Error(`Task ${taskId} not found`);
		}

		if (task.status !== 'running') {
			throw new Error(`Task ${taskId} is not running (status: ${task.status})`);
		}

		const terminalOutput = readTerminalFile(taskId, 200);
		if (!terminalOutput || terminalOutput.trim().length === 0) {
			throw new Error(`No terminal output for task ${taskId}`);
		}

		const analysis = await this.analyzeTerminalOutput(
			terminalOutput,
			task.task_description
		);

		await this.storeAnalysis(taskId, analysis);

		return analysis;
	}

	/**
	 * Get the latest analysis for a task
	 */
	async getLatestAnalysis(taskId: string): Promise<TaskAnalysis | null> {
		const task = await getTaskById(taskId);
		if (!task) {
			return null;
		}

		const metadata = task.metadata as TaskMonitoringMetadata | null;
		return metadata?.monitoring?.last_analysis || null;
	}
}

// Export singleton instance
export const taskStatusMonitor = new TaskStatusMonitor();

// Start the monitor if running as a standalone script
if (import.meta.url === `file://${process.argv[1]}`) {
	const monitor = new TaskStatusMonitor();

	// Handle graceful shutdown
	process.on('SIGINT', async () => {
		console.log('\n[TaskStatusMonitor] Received SIGINT, shutting down...');
		await monitor.stop();
		process.exit(0);
	});

	process.on('SIGTERM', async () => {
		console.log('\n[TaskStatusMonitor] Received SIGTERM, shutting down...');
		await monitor.stop();
		process.exit(0);
	});

	monitor.start().catch((error) => {
		console.error('[TaskStatusMonitor] Fatal error:', error);
		process.exit(1);
	});
}
