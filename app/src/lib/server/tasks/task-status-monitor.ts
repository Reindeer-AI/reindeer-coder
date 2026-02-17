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
import { getAllTasks, getTaskById, type Task, updateTaskMetadata } from '../db';
import { getAnthropicApiKey } from '../secrets';
import { readTerminalFile } from '../terminal-storage';
import {
	getActiveConnection,
	getConnectionInfo,
	manualReconnect,
	sendInstruction,
} from '../vm/orchestrator';
import { CodeReviewHandler } from './code-review-handler';

/**
 * Analysis result from AI
 */
export interface TaskAnalysis {
	state:
		| 'agent_idle_waiting'
		| 'agent_working'
		| 'agent_needs_input'
		| 'agent_stuck'
		| 'agent_completed';
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
		last_auto_action?: {
			timestamp: string;
			state: TaskAnalysis['state'];
			instruction: string;
		};
		suggested_instruction?: {
			timestamp: string;
			state: TaskAnalysis['state'];
			instruction: string;
		};
		last_code_review_check?: {
			timestamp: string;
			review_sha?: string;
		};
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
	private codeReviewHandler: CodeReviewHandler;

	private autoSendEnabled: boolean;

	constructor() {
		// Default: check every 60 seconds
		this.pollIntervalMs = parseInt(env.TASK_MONITOR_POLL_INTERVAL_MS || '60000', 10);
		// Default: auto-send is DISABLED for safety
		this.autoSendEnabled = env.TASK_MONITOR_AUTO_SEND_INSTRUCTIONS === 'true';
		this.codeReviewHandler = new CodeReviewHandler();
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
		console.log(
			`[TaskStatusMonitor] Auto-send instructions: ${this.autoSendEnabled ? 'ENABLED' : 'DISABLED (safe mode)'}`
		);

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
				console.error(`[TaskStatusMonitor] Error analyzing task ${task.id}:`, error);
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

		// Check SSH connection status - we need one to send instructions
		let connInfo = getConnectionInfo(task.id);
		if (!connInfo.hasConnection || connInfo.status !== 'connected') {
			console.log(
				`[TaskStatusMonitor] Task ${task.id} has no active SSH connection (status: ${connInfo.status || 'none'}), attempting to connect...`
			);

			// Attempt to establish connection (won't kick out other clients now)
			const connected = await manualReconnect(task.id);
			if (!connected) {
				console.log(`[TaskStatusMonitor] Failed to connect to task ${task.id}, skipping analysis`);
				return;
			}

			// Wait a few seconds for terminal data to start flowing
			await new Promise((resolve) => setTimeout(resolve, 3000));

			// Recheck connection
			connInfo = getConnectionInfo(task.id);
			if (!connInfo.hasConnection || connInfo.status !== 'connected') {
				console.log(
					`[TaskStatusMonitor] Connection not established for task ${task.id}, skipping analysis`
				);
				return;
			}

			console.log(`[TaskStatusMonitor] Successfully connected to task ${task.id}`);
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

		// Try to detect and store MR/PR URL from terminal output if not already stored
		if (!task.mr_url) {
			try {
				await this.codeReviewHandler.detectAndStoreMRInfo(task.id, terminalOutput);
			} catch (error) {
				// Non-critical - just log and continue
				console.log(
					`[TaskStatusMonitor] Could not detect MR URL for task ${task.id}:`,
					error instanceof Error ? error.message : String(error)
				);
			}
		}

		// Analyze with Claude
		const analysis = await this.analyzeTerminalOutput(terminalOutput, task.task_description);

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
		console.log(`[TaskStatusMonitor] Task ${task.id} analysis:`, {
			state: analysis.state,
			summary: analysis.summary,
			confidence: analysis.confidence,
		});

		// Get auto-continue count to prevent infinite loops
		const metadata = task.metadata as TaskMonitoringMetadata | null;
		let autoContinueCount = metadata?.monitoring?.auto_continue_count || 0;
		const MAX_AUTO_CONTINUES = 3;

		// Reset counter if state changed (indicates previous instructions had some effect)
		const lastAutoAction = metadata?.monitoring?.last_auto_action;
		if (lastAutoAction && lastAutoAction.state !== analysis.state) {
			console.log(
				`[TaskStatusMonitor] State changed from ${lastAutoAction.state} to ${analysis.state} for task ${task.id}, resetting auto-continue counter`
			);
			autoContinueCount = 0;
			await updateTaskMetadata(task.id, {
				monitoring: {
					...metadata?.monitoring,
					auto_continue_count: 0,
				},
			});
		}

		// Reset counter if it's been more than 10 minutes since last action
		// This handles cases where instructions were sent but didn't work
		if (lastAutoAction) {
			const timeSinceLastAction = Date.now() - new Date(lastAutoAction.timestamp).getTime();
			const TEN_MINUTES = 10 * 60 * 1000;
			if (timeSinceLastAction > TEN_MINUTES && autoContinueCount > 0) {
				console.log(
					`[TaskStatusMonitor] Last action was ${Math.floor(timeSinceLastAction / 60000)} minutes ago for task ${task.id}, resetting auto-continue counter`
				);
				autoContinueCount = 0;
				await updateTaskMetadata(task.id, {
					monitoring: {
						...metadata?.monitoring,
						auto_continue_count: 0,
					},
				});
			}
		}

		// Only take autonomous actions if confidence is high enough
		if (analysis.confidence < 70) {
			return;
		}

		// Check if we have an active connection
		const conn = getActiveConnection(task.id);
		if (!conn) {
			console.log(
				`[TaskStatusMonitor] No active connection for task ${task.id}, skipping autonomous actions`
			);
			return;
		}

		// Limit total auto-continues to prevent infinite loops
		if (autoContinueCount >= MAX_AUTO_CONTINUES) {
			console.log(
				`[TaskStatusMonitor] Max auto-continues (${MAX_AUTO_CONTINUES}) reached for task ${task.id}`
			);
			return;
		}

		try {
			let instruction: string | null = null;

			switch (analysis.state) {
				case 'agent_completed':
					// Agent claims it's done - first check for code review comments
					if (task.mr_url) {
						try {
							// Check if we've already sent review comments for the current MR SHA
							const lastReviewCheck = metadata?.monitoring?.last_code_review_check;
							const currentMRSha = task.mr_last_review_sha;

							const shouldCheckReview =
								!lastReviewCheck || !currentMRSha || lastReviewCheck.review_sha !== currentMRSha;

							if (shouldCheckReview) {
								console.log(
									`[TaskStatusMonitor] Checking for code review comments on task ${task.id}`
								);

								// Check if there are code review comments that need to be addressed
								const reviewInstruction = await this.codeReviewHandler.getCodeReviewInstruction(
									task.id,
									task.task_description,
									task.mr_url
								);

								// Update the last review check
								await updateTaskMetadata(task.id, {
									monitoring: {
										...metadata?.monitoring,
										last_code_review_check: {
											timestamp: new Date().toISOString(),
											review_sha: task.mr_last_review_sha || undefined,
										},
									},
								});

								// If we got review instruction, it means there are unresolved comments
								if (reviewInstruction?.includes('⚠️')) {
									console.log(
										`[TaskStatusMonitor] Found unresolved code review comments for task ${task.id}`
									);
									instruction = reviewInstruction;
								} else {
									console.log(
										`[TaskStatusMonitor] No unresolved code review comments for task ${task.id}`
									);
									// No unresolved comments - check MR status
									instruction = `Task complete with MR at ${task.mr_url}. Check: Are pipelines passing? Is MR reviewed/ready? If yes and merged, confirm completion. If pipelines fail, fix them.`;
								}
							} else {
								console.log(
									`[TaskStatusMonitor] Already checked code review for task ${task.id} at SHA ${currentMRSha}, skipping`
								);
								// Already checked for this SHA - just verify MR status
								instruction = `Task complete with MR at ${task.mr_url}. Check: Are pipelines passing? If yes and MR merged, confirm completion. If pipelines fail, fix them.`;
							}
						} catch (error) {
							console.log(
								`[TaskStatusMonitor] Could not check code review comments for task ${task.id}:`,
								error instanceof Error ? error.message : String(error)
							);
							// Fallback to generic MR status check
							instruction = `Task complete with MR at ${task.mr_url}. Check: Are pipelines passing? Is MR reviewed/ready? If yes and merged, confirm completion. If pipelines fail, fix them.`;
						}
					} else {
						instruction = `Task appears complete but no MR URL recorded. If you created an MR, please paste the full URL (https://gitlab.com/...). If not, create one now and share the URL.`;
					}
					break;

				case 'agent_idle_waiting':
					// Agent is idle - nudge it to continue or wrap up
					instruction = `You appear idle. If task complete, create an MR. If more work needed, continue. If waiting for something, let me know what.`;
					break;

				case 'agent_stuck':
					// Agent is stuck - offer debugging help
					instruction = `You might be stuck with an error. Review error messages, try a different approach, or use git reset if needed. Check task description to ensure you're on track.`;
					break;

				case 'agent_needs_input':
					// Agent explicitly needs input - don't auto-continue, but log it
					console.log(`[TaskStatusMonitor] Task ${task.id} needs user input - not auto-continuing`);
					return;

				case 'agent_working':
					// Agent is working fine - don't interrupt
					return;
			}

			if (instruction) {
				if (!this.autoSendEnabled) {
					console.log(
						`[TaskStatusMonitor] Would send instruction to task ${task.id} (state: ${analysis.state}), but auto-send is DISABLED`
					);
					console.log(`[TaskStatusMonitor] Suggested instruction: ${instruction}`);
					// Store the suggested instruction even if not sent
					await updateTaskMetadata(task.id, {
						monitoring: {
							...metadata?.monitoring,
							suggested_instruction: {
								timestamp: new Date().toISOString(),
								state: analysis.state,
								instruction: instruction,
							},
						},
					});
					return;
				}

				console.log(
					`[TaskStatusMonitor] Sending autonomous instruction to task ${task.id} (state: ${analysis.state})`
				);

				// Update auto-continue count
				await updateTaskMetadata(task.id, {
					monitoring: {
						...metadata?.monitoring,
						auto_continue_count: autoContinueCount + 1,
						last_auto_action: {
							timestamp: new Date().toISOString(),
							state: analysis.state,
							instruction: instruction.substring(0, 200) + '...', // Store truncated version
						},
					},
				});

				// Send the instruction via SSH
				await sendInstruction(task.id, instruction);
				console.log(`[TaskStatusMonitor] Autonomous instruction sent to task ${task.id}`);
			}
		} catch (error) {
			console.error(
				`[TaskStatusMonitor] Error sending autonomous instruction to task ${task.id}:`,
				error
			);
		}
	}

	/**
	 * Automatically continue an agent with a gentle prompt
	 */
	async autoContinueAgent(task: Task, _analysis: TaskAnalysis): Promise<boolean> {
		try {
			// Check if we have an active connection
			const conn = getActiveConnection(task.id);
			if (!conn) {
				console.log(`[TaskStatusMonitor] Cannot auto-continue ${task.id}: no active connection`);
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
			console.error(`[TaskStatusMonitor] Error auto-continuing task ${task.id}:`, error);
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

		const analysis = await this.analyzeTerminalOutput(terminalOutput, task.task_description);

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
