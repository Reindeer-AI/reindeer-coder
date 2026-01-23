import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import { configService } from '../config-service';
import {
	appendTerminalBuffer as appendTerminalBufferRaw,
	getTaskById,
	updateTaskMetadata,
	updateTaskStatus,
	updateTaskVmName,
	updateTaskVmZone,
} from '../db';
import type { Task } from '../db/schema';
import { getAnthropicApiKey } from '../secrets';
import {
	connectToVM,
	copyToVM,
	execOnVM,
	execOnVMStreaming,
	type GcloudConnection,
} from './gcloud';

/**
 * Extract a readable name from an email address
 * Examples:
 *   "john.doe@reindeer.ai" -> "John Doe"
 *   "jane_smith@company.com" -> "Jane Smith"
 *   "bob@example.com" -> "Bob"
 */
function extractNameFromEmail(email: string): string {
	const username = email.split('@')[0];
	return username
		.replace(/[._-]/g, ' ')
		.split(' ')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(' ');
}

// Connection state tracking
interface ConnectionState {
	conn: GcloudConnection;
	status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
	tmuxSession: string;
	lastActivity: Date;
	reconnectAttempts: number;
	vmName: string;
	zone: string;
	project: string;
}

// Active connections by task ID
const activeConnections = new Map<string, ConnectionState>();

// Max reconnect attempts before giving up
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 5000;
// Check connection health every 30 seconds
const CONNECTION_HEALTH_CHECK_INTERVAL_MS = 30000;
// Maximum time without activity before considering connection stale (5 minutes)
const CONNECTION_STALE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Background health monitoring - checks all active connections and auto-reconnects if needed
 */
async function monitorConnectionHealth(): Promise<void> {
	for (const [taskId, state] of activeConnections.entries()) {
		// Skip if already reconnecting or disconnected
		if (state.status === 'reconnecting' || state.status === 'disconnected') {
			continue;
		}

		// Check if task is still in a running state
		const task = await getTaskById(taskId);
		if (!task || !['running', 'cloning'].includes(task.status)) {
			// Task no longer needs connection
			continue;
		}

		// Check if connection has been inactive for too long
		const timeSinceActivity = Date.now() - state.lastActivity.getTime();
		if (timeSinceActivity > CONNECTION_STALE_TIMEOUT_MS && state.status === 'connected') {
			console.log(
				`[health-check] Connection for task ${taskId} appears stale (${Math.floor(timeSinceActivity / 1000)}s since activity), triggering reconnect`
			);
			handleConnectionLoss(taskId);
		}
	}

	// Check for tasks that need connection but don't have one
	// This handles the case where the server was restarted
	// Note: We'll implement this in a future iteration to avoid aggressive reconnection
}

// Start the background health monitor
let healthCheckInterval: NodeJS.Timeout | null = null;
if (!healthCheckInterval) {
	healthCheckInterval = setInterval(monitorConnectionHealth, CONNECTION_HEALTH_CHECK_INTERVAL_MS);
	console.log('[orchestrator] Background connection health monitor started');
}

/**
 * Redact sensitive values from terminal output
 */
function redactSensitive(text: string): string {
	// Patterns for various API keys and tokens
	const patterns = [
		// Anthropic API keys (sk-ant-...)
		/sk-ant-[a-zA-Z0-9_-]{20,}/g,
		// OpenAI API keys (sk-...)
		/sk-[a-zA-Z0-9]{20,}/g,
		// Google API keys
		/AIza[a-zA-Z0-9_-]{35}/g,
		// GitLab tokens (glpat-...)
		/glpat-[a-zA-Z0-9_-]{20,}/g,
		// GitHub tokens (ghp_..., gho_..., ghu_..., ghs_..., ghr_...)
		/gh[pousr]_[a-zA-Z0-9]{36,}/g,
		// Git clone URLs with tokens (https://user:TOKEN@gitlab.com/...)
		/(https:\/\/[^:]+:)[^@\s]+(@(?:gitlab|github)\.com)/gi,
		// Generic Bearer tokens in export commands
		/export\s+[A-Z_]*(?:KEY|TOKEN|SECRET)[A-Z_]*=["']?([^"'\s]+)["']?/gi,
		// Environment variable assignments with sensitive names
		/(ANTHROPIC_API_KEY|OPENAI_API_KEY|GITLAB_TOKEN|GIT_TOKEN|API_KEY|SECRET|TOKEN|PASSWORD)=["']?([^"'\s\r\n]+)["']?/gi,
	];

	let result = text;
	for (const pattern of patterns) {
		result = result.replace(pattern, (match, g1, g2) => {
			// For git clone URLs with tokens (https://user:TOKEN@...), reconstruct with [REDACTED]
			if (match.startsWith('https://') && match.includes(':') && match.includes('@')) {
				return `${g1}[REDACTED]${g2}`;
			}
			// For env var assignments, preserve the var name but redact the value
			if (match.includes('=')) {
				const eqIndex = match.indexOf('=');
				const varPart = match.substring(0, eqIndex + 1);
				return `${varPart}[REDACTED]`;
			}
			// For standalone keys, show first 8 chars then redact
			if (match.length > 12) {
				return `${match.substring(0, 8)}...[REDACTED]`;
			}
			return '[REDACTED]';
		});
	}
	return result;
}

/**
 * Append to terminal buffer with automatic redaction of sensitive data
 */
function appendTerminalBuffer(taskId: string, content: string): void {
	appendTerminalBufferRaw(taskId, redactSensitive(content));
}

/**
 * Extract namespace/repo from any git URL format
 * https://gitlab.com/user/repo.git -> user/repo
 * https://gitlab.com/user/repo -> user/repo
 * git@gitlab.com:user/repo.git -> user/repo
 * user/repo -> user/repo
 */
function extractRepoPath(repoUrl: string): string {
	// Remove .git suffix if present
	const url = repoUrl.replace(/\.git$/, '');

	// SSH format: git@gitlab.com:user/repo
	const sshMatch = url.match(/^git@[^:]+:(.+)$/);
	if (sshMatch) {
		return sshMatch[1];
	}

	// HTTPS format: https://gitlab.com/user/repo
	const httpsMatch = url.match(/^https?:\/\/[^/]+\/(.+)$/);
	if (httpsMatch) {
		return httpsMatch[1];
	}

	// Already in namespace/repo format
	return url;
}

/**
 * Generate a meaningful branch name using LLM to understand the task purpose
 * Examples:
 *   Linear ticket "REI-286: Vibe to open meaningful branch names" -> "vibe-coding/use-llm-for-branch-names"
 *   Task description "Add dark mode toggle to settings" -> "vibe-coding/add-dark-mode-toggle"
 *   No meaningful data -> "vibe-coding/530e6ac4" (fallback to hash)
 */
async function generateBranchName(task: Task): Promise<string> {
	// Get branch prefix from config
	const branchPrefix = await configService.get('git.branch_prefix', 'agent', 'GIT_BRANCH_PREFIX');
	// Slugify fallback function for error cases
	const slugifyFallback = (text: string, maxLength: number = 50): string => {
		return text
			.toLowerCase()
			.trim()
			.replace(/[\s_]+/g, '-')
			.replace(/[^a-z0-9-]/g, '')
			.replace(/^-+|-+$/g, '')
			.substring(0, maxLength)
			.replace(/-+$/, '');
	};

	// Try LLM-based branch name generation
	try {
		let apiKey: string;
		try {
			apiKey = await getAnthropicApiKey();
		} catch {
			console.warn('[generateBranchName] ANTHROPIC_API_KEY not configured, using fallback');
			return generateFallbackBranchName(task, slugifyFallback);
		}

		const client = new Anthropic({ apiKey });

		// Build context for the LLM
		let context = '';
		if (task.metadata?.linear?.issue_identifier && task.metadata?.linear?.issue_title) {
			context += `Linear Ticket: ${task.metadata?.linear?.issue_identifier} - ${task.metadata?.linear?.issue_title}\n`;
		}
		if (task.task_description) {
			// Truncate to first 500 chars to avoid token limits
			const desc = task.task_description.substring(0, 500);
			context += `Description: ${desc}\n`;
		}

		if (!context.trim()) {
			console.warn('[generateBranchName] No context available, using fallback');
			return generateFallbackBranchName(task, slugifyFallback);
		}

		// Prompt the LLM to generate a concise branch name with strict format guidelines
		const prompt = `You are a git branch naming expert. Generate a concise, meaningful git branch name that describes the purpose of this task.

## Task Information
${context}

## CRITICAL FORMAT REQUIREMENTS - FOLLOW EXACTLY:
1. Output ONLY the branch name slug - no quotes, no markdown, no explanation, no prefix
2. Use ONLY lowercase letters (a-z), numbers (0-9), and hyphens (-)
3. Start with a letter or number (not a hyphen)
4. End with a letter or number (not a hyphen)
5. Maximum 50 characters total
6. Use hyphens to separate words (kebab-case)
7. If a Linear ticket ID exists (e.g., REI-286), start with it: "rei-286-description"
8. Capture the INTENT/PURPOSE, not just keywords from the title
9. Be concise but descriptive (e.g., "add-user-auth", "fix-memory-leak", "refactor-api")
10. Avoid generic words like "feature", "task", "implement"

## Examples (showing EXACT output format):
rei-286-use-llm-for-branch-names
add-dark-mode-toggle
fix-websocket-memory-leak
refactor-auth-to-jwt

Your response must be a single line with ONLY the branch name slug following the format above:`;

		const response = await client.messages.create({
			model: 'claude-sonnet-4-5-20250929',
			max_tokens: 100,
			messages: [
				{
					role: 'user',
					content: prompt,
				},
			],
			temperature: 0.3, // Lower temperature for more consistent formatting
		});

		// Extract the text response
		const textContent = response.content.find((block) => block.type === 'text');
		if (!textContent || textContent.type !== 'text') {
			console.warn('[generateBranchName] No text content in LLM response, using fallback');
			return generateFallbackBranchName(task, slugifyFallback);
		}

		// Get the branch name - only trim whitespace, trust the model for everything else
		const branchName = textContent.text.trim();

		// Basic validation only - check if empty or clearly invalid
		if (!branchName || branchName.length < 3 || branchName.length > 50) {
			console.warn(
				`[generateBranchName] Generated branch name invalid (length: ${branchName.length}), using fallback`
			);
			return generateFallbackBranchName(task, slugifyFallback);
		}

		console.log(`[generateBranchName] LLM generated branch name: ${branchPrefix}/${branchName}`);
		return `${branchPrefix}/${branchName}`;
	} catch (error) {
		console.error('[generateBranchName] Error calling LLM:', error);
		return generateFallbackBranchName(task, slugifyFallback);
	}
}

/**
 * Fallback branch name generation using slugify (previous behavior)
 */
async function generateFallbackBranchName(
	task: Task,
	slugify: (text: string, maxLength?: number) => string
): Promise<string> {
	const branchPrefix = await configService.get('git.branch_prefix', 'agent', 'GIT_BRANCH_PREFIX');

	// Try to use Linear issue info first (preferred)
	if (task.metadata?.linear?.issue_identifier && task.metadata?.linear?.issue_title) {
		const issueSlug = slugify(task.metadata?.linear?.issue_identifier, 20);
		const titleSlug = slugify(task.metadata?.linear?.issue_title, 50);
		if (issueSlug && titleSlug) {
			return `${branchPrefix}/${issueSlug}-${titleSlug}`;
		}
	}

	// Fallback to Linear identifier only
	if (task.metadata?.linear?.issue_identifier) {
		const issueSlug = slugify(task.metadata?.linear?.issue_identifier, 20);
		if (issueSlug) {
			return `${branchPrefix}/${issueSlug}`;
		}
	}

	// Fallback to task description
	if (task.task_description) {
		const descSlug = slugify(task.task_description, 60);
		if (descSlug) {
			return `${branchPrefix}/${descSlug}`;
		}
	}

	// Final fallback: use task ID hash
	return `${branchPrefix}/${task.id.slice(0, 8)}`;
}

/**
 * Execute a gcloud command and return stdout
 */
async function gcloud(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn('gcloud', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';

		proc.stdout?.on('data', (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on('error', reject);
		proc.on('close', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`gcloud failed (code ${code}): ${stderr}`));
			}
		});
	});
}

/**
 * Get the active gcloud connection for a task
 */
export function getActiveConnection(taskId: string): GcloudConnection | undefined {
	const state = activeConnections.get(taskId);
	return state?.conn;
}

/**
 * Update the last activity timestamp for a connection
 * This should be called whenever we interact with the connection (even just reading)
 */
export function touchConnection(taskId: string): void {
	const state = activeConnections.get(taskId);
	if (state) {
		state.lastActivity = new Date();
		console.log(`[orchestrator] Touched connection for task ${taskId}`);
	}
}

/**
 * Get the connection status for a task
 */
export function getConnectionStatus(
	taskId: string
): { status: string; tmuxSession: string; lastActivity: Date } | null {
	const state = activeConnections.get(taskId);
	if (!state) return null;
	return {
		status: state.status,
		tmuxSession: state.tmuxSession,
		lastActivity: state.lastActivity,
	};
}

/**
 * Attempt to reconnect to a task's tmux session
 */
async function reconnectToTmux(taskId: string): Promise<boolean> {
	const state = activeConnections.get(taskId);
	if (!state) {
		console.error(`[reconnect] No state found for task ${taskId}`);
		return false;
	}

	if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
		console.error(
			`[reconnect] Max attempts (${MAX_RECONNECT_ATTEMPTS}) reached for task ${taskId}`
		);
		appendTerminalBuffer(
			taskId,
			`\r\n[error] Max reconnection attempts reached. Connection lost.\r\n`
		);
		await updateTaskStatus(taskId, 'failed');
		activeConnections.delete(taskId);
		return false;
	}

	state.status = 'reconnecting';
	state.reconnectAttempts++;
	appendTerminalBuffer(
		taskId,
		`\r\n[system] Reconnecting to session (attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...\r\n`
	);

	try {
		// Close old connection if exists
		try {
			state.conn.close();
		} catch {
			// Ignore close errors
		}

		// Wait before reconnecting
		await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));

		// Create new SSH connection
		const conn = connectToVM(state.vmName, state.zone, state.project);

		// Set up handlers
		conn.onData((data) => {
			state.lastActivity = new Date();
			appendTerminalBuffer(taskId, data);
		});

		conn.onError((error) => {
			appendTerminalBuffer(taskId, `\r\n[error] SSH Error: ${error.message}\r\n`);
			handleConnectionLoss(taskId);
		});

		conn.onClose(async (code) => {
			const currentTask = await getTaskById(taskId);
			if (currentTask && ['running', 'cloning'].includes(currentTask.status)) {
				// Unexpected close - try to reconnect
				appendTerminalBuffer(
					taskId,
					`\r\n[system] Connection lost (code: ${code}). Attempting to reconnect...\r\n`
				);
				handleConnectionLoss(taskId);
			}
		});

		// Wait for connection to establish
		await new Promise((resolve) => setTimeout(resolve, 3000));

		// Switch to VM user
		const vmUser = await configService.get('vm.user', 'agent', 'VM_USER');
		appendTerminalBuffer(taskId, `[system] Switching to ${vmUser} user...\r\n`);
		conn.write(`sudo su - ${vmUser}\n`);
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Reattach to tmux session (with fallback to screen for backwards compatibility)
		appendTerminalBuffer(taskId, `[system] Reattaching to session: ${state.tmuxSession}\r\n`);
		conn.write(
			`tmux attach-session -d -t ${state.tmuxSession} 2>/dev/null || tmux new-session -s ${state.tmuxSession} 2>/dev/null || screen -r ${state.tmuxSession} 2>/dev/null || screen -S ${state.tmuxSession}\n`
		);

		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Reload tmux config to ensure mouse support is enabled
		conn.write(`tmux source-file ~/.tmux.conf 2>/dev/null || true\n`);

		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Update state
		state.conn = conn;
		state.status = 'connected';
		state.reconnectAttempts = 0;
		state.lastActivity = new Date();

		appendTerminalBuffer(taskId, `[system] Successfully reconnected to session!\r\n`);
		return true;
	} catch (error) {
		console.error(`[reconnect] Failed for task ${taskId}:`, error);
		appendTerminalBuffer(taskId, `[error] Reconnection failed: ${(error as Error).message}\r\n`);
		// Try again
		setTimeout(() => reconnectToTmux(taskId), RECONNECT_DELAY_MS);
		return false;
	}
}

/**
 * Handle connection loss - attempt reconnection
 */
async function handleConnectionLoss(taskId: string): Promise<void> {
	const state = activeConnections.get(taskId);
	if (!state || state.status === 'reconnecting') return;

	const task = await getTaskById(taskId);
	if (!task || !['running', 'cloning'].includes(task.status)) {
		// Task is not in a running state, don't try to reconnect
		activeConnections.delete(taskId);
		return;
	}

	state.status = 'disconnected';
	await reconnectToTmux(taskId);
}

/**
 * Manually reconnect to a task's VM and tmux session
 * This can be called even when no connection state exists (e.g., after server restart)
 */
export async function manualReconnect(taskId: string): Promise<boolean> {
	const task = await getTaskById(taskId);
	if (!task) {
		console.error(`[manual-reconnect] Task ${taskId} not found`);
		return false;
	}

	if (!task.vm_name) {
		console.error(`[manual-reconnect] Task ${taskId} has no VM name`);
		appendTerminalBuffer(
			taskId,
			`\r\n[error] Cannot reconnect: no VM associated with this task\r\n`
		);
		return false;
	}

	// Check if we already have a connection
	const existingState = activeConnections.get(taskId);
	if (existingState && existingState.status === 'connected') {
		appendTerminalBuffer(taskId, `\r\n[system] Already connected to session.\r\n`);
		return true;
	}

	// If there's an existing state, try the regular reconnect
	if (existingState) {
		existingState.reconnectAttempts = 0; // Reset attempts for manual reconnect
		return reconnectToTmux(taskId);
	}

	// No existing state - create a fresh connection
	const project = env.GCP_PROJECT_ID;
	const zone = env.GCP_ZONE || 'us-central1-a';

	if (!project) {
		appendTerminalBuffer(taskId, `\r\n[error] GCP_PROJECT_ID not configured\r\n`);
		return false;
	}

	appendTerminalBuffer(taskId, `\r\n========================================\r\n`);
	appendTerminalBuffer(taskId, `[system] Manual reconnection initiated\r\n`);
	appendTerminalBuffer(taskId, `[system] VM: ${task.vm_name}\r\n`);
	appendTerminalBuffer(taskId, `========================================\r\n\r\n`);

	try {
		// Verify VM exists before connecting
		appendTerminalBuffer(taskId, `[system] Verifying VM exists...\r\n`);
		try {
			await gcloud([
				'compute',
				'instances',
				'describe',
				task.vm_name,
				`--project=${project}`,
				`--zone=${zone}`,
				'--format=value(status)',
			]);
		} catch {
			appendTerminalBuffer(taskId, `[error] VM ${task.vm_name} not found or not accessible\r\n`);
			return false;
		}

		appendTerminalBuffer(taskId, `[system] VM found, establishing SSH connection...\r\n`);

		// Create new SSH connection
		const conn = connectToVM(task.vm_name, zone, project);
		const tmuxSession = `vibe-${taskId.slice(0, 8)}`;

		// Create new connection state
		const connState: ConnectionState = {
			conn,
			status: 'connecting',
			tmuxSession,
			lastActivity: new Date(),
			reconnectAttempts: 0,
			vmName: task.vm_name,
			zone,
			project,
		};
		activeConnections.set(taskId, connState);

		// Set up handlers
		conn.onData((data) => {
			connState.lastActivity = new Date();
			appendTerminalBuffer(taskId, data);
		});

		conn.onError((error) => {
			appendTerminalBuffer(taskId, `\r\n[error] SSH Error: ${error.message}\r\n`);
			handleConnectionLoss(taskId);
		});

		conn.onClose(async (code) => {
			const currentTask = await getTaskById(taskId);
			if (currentTask && ['running', 'cloning'].includes(currentTask.status)) {
				appendTerminalBuffer(
					taskId,
					`\r\n[system] Connection lost (code: ${code}). Attempting to reconnect...\r\n`
				);
				handleConnectionLoss(taskId);
			} else {
				activeConnections.delete(taskId);
			}
		});

		// Wait for connection to establish
		await new Promise((resolve) => setTimeout(resolve, 3000));

		// Switch to VM user
		const vmUser = await configService.get('vm.user', 'agent', 'VM_USER');
		appendTerminalBuffer(taskId, `[system] Switching to ${vmUser} user...\r\n`);
		conn.write(`sudo su - ${vmUser}\n`);
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Reattach to existing session (tmux or screen for backwards compatibility)
		appendTerminalBuffer(taskId, `[system] Reattaching to session: ${tmuxSession}\r\n`);
		conn.write(
			`tmux attach-session -d -t ${tmuxSession} 2>/dev/null || tmux new-session -s ${tmuxSession} 2>/dev/null || screen -r ${tmuxSession} 2>/dev/null || screen -S ${tmuxSession}\n`
		);

		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Reload tmux config to ensure mouse support is enabled
		conn.write(`tmux source-file ~/.tmux.conf 2>/dev/null || true\n`);

		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Update state
		connState.status = 'connected';

		appendTerminalBuffer(taskId, `\r\n[system] Successfully reconnected!\r\n`);
		appendTerminalBuffer(taskId, `[system] You can now interact with the terminal.\r\n`);
		appendTerminalBuffer(taskId, `========================================\r\n\r\n`);

		return true;
	} catch (error) {
		console.error(`[manual-reconnect] Failed for task ${taskId}:`, error);
		appendTerminalBuffer(
			taskId,
			`\r\n[error] Reconnection failed: ${(error as Error).message}\r\n`
		);
		activeConnections.delete(taskId);
		return false;
	}
}

/**
 * Start a coding task: provision VM, clone repo, run agent
 */
export async function startTask(taskId: string): Promise<void> {
	const task = await getTaskById(taskId);
	if (!task) {
		throw new Error(`Task ${taskId} not found`);
	}

	const project = env.GCP_PROJECT_ID;
	const zone = env.GCP_ZONE || 'us-central1-a';
	const vmServiceAccount = env.GCP_VM_SERVICE_ACCOUNT;
	const network = env.GCP_NETWORK;
	const subnet = env.GCP_SUBNET;

	if (!project) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}

	const vmName = `vibe-coding-${taskId.slice(0, 8)}-${Date.now()}`;
	await updateTaskVmName(taskId, vmName);
	await updateTaskVmZone(taskId, zone);
	await updateTaskStatus(taskId, 'provisioning');

	// Save VM user and workspace path to task metadata (captured from config for stability)
	const vmUser = await configService.get('vm.user', 'agent', 'VM_USER');
	const workspacePath = `/home/${vmUser}/workspace`;
	await updateTaskMetadata(taskId, { vm_user: vmUser, workspace_path: workspacePath });

	// Log configuration
	appendTerminalBuffer(taskId, `\r\n========================================\r\n`);
	appendTerminalBuffer(taskId, `[system] Starting task: ${taskId}\r\n`);
	appendTerminalBuffer(taskId, `[config] Project: ${project}\r\n`);
	appendTerminalBuffer(taskId, `[config] Zone: ${zone}\r\n`);
	appendTerminalBuffer(taskId, `[config] Network: ${network}\r\n`);
	appendTerminalBuffer(taskId, `[config] Subnet: ${subnet || 'default'}\r\n`);
	appendTerminalBuffer(taskId, `[config] VM Name: ${vmName}\r\n`);
	appendTerminalBuffer(taskId, `[config] CLI: ${task.coding_cli}\r\n`);
	appendTerminalBuffer(taskId, `========================================\r\n\r\n`);
	appendTerminalBuffer(taskId, `[system] Provisioning VM: ${vmName}\r\n`);

	try {
		const machineType = env.VM_MACHINE_TYPE;
		const imageFamily = env.VM_IMAGE_FAMILY;
		const imageProject = env.VM_IMAGE_PROJECT;

		// Extract git user identity from task
		const fallbackEmail = await configService.get(
			'email.fallback_address',
			'agent@example.com',
			'EMAIL_FALLBACK_ADDRESS'
		);
		const gitUserName =
			task.user_email === 'unknown' ? 'Code Agent' : extractNameFromEmail(task.user_email);
		const gitUserEmail = task.user_email === 'unknown' ? fallbackEmail : task.user_email;

		// Build gcloud compute instances create command
		const createArgs = [
			'compute',
			'instances',
			'create',
			vmName,
			`--project=${project}`,
			`--zone=${zone}`,
			`--machine-type=${machineType}`,
			`--image-family=${imageFamily}`,
			`--image-project=${imageProject}`,
			'--boot-disk-size=50GB',
			'--boot-disk-type=pd-standard',
			`--network=${network}`,
			...(subnet ? [`--subnet=${subnet}`] : []),
			'--tags=iap-ssh',
			`--metadata=ANTHROPIC_API_KEY_SECRET=${env.ANTHROPIC_API_KEY_SECRET || ''},OPENAI_API_KEY_SECRET=${env.OPENAI_API_KEY_SECRET || ''},GOOGLE_API_KEY_SECRET=${env.GOOGLE_API_KEY_SECRET || ''},GITLAB_TOKEN_SECRET=${env.GITLAB_TOKEN_SECRET || ''},SECRET_IMPERSONATE_SA=${env.SECRET_IMPERSONATE_SA || ''},GIT_USER=${env.GIT_USER},GIT_USER_NAME=${gitUserName},GIT_USER_EMAIL=${gitUserEmail}`,
			`--labels=vibe-coding=true`,
			'--format=json',
		];

		// Always add cloud-platform scope to allow access to GCP resources
		createArgs.push('--scopes=cloud-platform');

		if (vmServiceAccount) {
			createArgs.push(`--service-account=${vmServiceAccount}`);
		}

		// Create the VM using gcloud CLI
		appendTerminalBuffer(taskId, `[system] Creating VM with gcloud...\r\n`);

		await new Promise<void>((resolve, reject) => {
			const proc = spawn('gcloud', createArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
			let _stdout = '';
			let stderr = '';

			proc.stdout?.on('data', (data: Buffer) => {
				_stdout += data.toString();
			});
			proc.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString();
				// Stream stderr to terminal (gcloud progress updates)
				// Normalize newlines for xterm: replace \n with \r\n (but not \r\n -> \r\r\n)
				const normalized = data.toString().replace(/\r?\n/g, '\r\n');
				appendTerminalBuffer(taskId, normalized);
			});
			proc.on('error', (err) => {
				reject(err);
			});
			proc.on('close', (code) => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(`gcloud instances create failed (code ${code}): ${stderr}`));
				}
			});
		});

		appendTerminalBuffer(taskId, `[system] VM created successfully!\r\n`);

		appendTerminalBuffer(
			taskId,
			`[system] Waiting for VM to boot and SSH to become available...\r\n`
		);
		appendTerminalBuffer(taskId, `[system] (This typically takes 30-90 seconds)\r\n\r\n`);

		// Wait for SSH to become available - VMs need time to boot and start sshd
		// Try connecting multiple times with increasing delays
		let conn: GcloudConnection | null = null;
		const maxAttempts = 5;
		const delays = [30000, 30000, 30000, 30000, 30000]; // 30s between attempts, total 2.5 min max

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const waitTime = delays[attempt - 1] / 1000;
			appendTerminalBuffer(
				taskId,
				`[ssh] Attempt ${attempt}/${maxAttempts} - waiting ${waitTime}s before connecting...\r\n`
			);

			// Wait before attempting
			await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));

			appendTerminalBuffer(taskId, `[ssh] Attempting IAP tunnel connection to ${vmName}...\r\n`);

			try {
				// Test SSH connectivity first
				const testResult = await new Promise<boolean>((resolve) => {
					const testConn = connectToVM(vmName, zone, project);
					let connected = false;
					let _receivedData = '';
					const timeout = setTimeout(() => {
						appendTerminalBuffer(taskId, `[ssh] Connection test timed out after 30s\r\n`);
						testConn.close();
						resolve(false);
					}, 30000); // 30s timeout for connection test

					testConn.onData((data) => {
						_receivedData += data;
						// Log all received data for debugging
						appendTerminalBuffer(taskId, `[ssh:data] ${data.replace(/\n/g, '\r\n')}`);
						if (!connected && (data.includes('$') || data.includes('#') || data.includes('~'))) {
							connected = true;
							clearTimeout(timeout);
							appendTerminalBuffer(taskId, `[ssh] Shell prompt detected!\r\n`);
							testConn.close();
							resolve(true);
						}
					});

					testConn.onClose((code) => {
						clearTimeout(timeout);
						if (!connected) {
							appendTerminalBuffer(taskId, `[ssh] Connection closed with code ${code}\r\n`);
							resolve(false);
						}
					});

					testConn.onError((err) => {
						clearTimeout(timeout);
						appendTerminalBuffer(taskId, `[ssh] Connection error: ${err.message}\r\n`);
						resolve(false);
					});

					// Send a test command after waiting for connection
					setTimeout(() => {
						appendTerminalBuffer(taskId, `[ssh] Sending test command...\r\n`);
						testConn.write('echo "SSH_READY"\n');
					}, 5000);
				});

				if (testResult) {
					appendTerminalBuffer(taskId, '\r\n[system] SSH connection established!\r\n\r\n');

					// Execute startup script via SSH with streaming output
					await deployAndExecuteStartupScript(taskId, vmName, task.coding_cli, zone, project);

					break;
				} else {
					appendTerminalBuffer(taskId, `[ssh] Connection test failed, will retry...\r\n\r\n`);
				}
			} catch (err) {
				appendTerminalBuffer(
					taskId,
					`[ssh] Attempt ${attempt} error: ${(err as Error).message}\r\n\r\n`
				);
			}

			if (attempt === maxAttempts) {
				throw new Error('Failed to establish SSH connection after multiple attempts');
			}
		}

		// Connect to the VM
		await updateTaskStatus(taskId, 'initializing');
		appendTerminalBuffer(taskId, `\r\n========================================\r\n`);
		appendTerminalBuffer(taskId, `[system] Establishing persistent SSH connection...\r\n`);
		appendTerminalBuffer(taskId, `[system] VM setup complete, initializing workspace...\r\n`);
		appendTerminalBuffer(taskId, `========================================\r\n\r\n`);

		conn = connectToVM(vmName, zone, project);

		// Create tmux session name based on task ID
		const tmuxSession = `vibe-${taskId.slice(0, 8)}`;

		// Create connection state
		const connState: ConnectionState = {
			conn,
			status: 'connecting',
			tmuxSession,
			lastActivity: new Date(),
			reconnectAttempts: 0,
			vmName,
			zone,
			project,
		};
		activeConnections.set(taskId, connState);

		// Pipe output to terminal buffer with prefix for clarity
		conn.onData((data) => {
			// Stream all VM output directly to terminal
			connState.lastActivity = new Date();
			appendTerminalBuffer(taskId, data);
		});

		conn.onError((error) => {
			appendTerminalBuffer(taskId, `\r\n[error] SSH Error: ${error.message}\r\n`);
			handleConnectionLoss(taskId);
		});

		conn.onClose(async (code) => {
			appendTerminalBuffer(taskId, `\r\n[system] SSH connection closed (exit code: ${code})\r\n`);
			const currentTask = await getTaskById(taskId);
			if (currentTask && ['running', 'cloning'].includes(currentTask.status)) {
				// Unexpected close - try to reconnect
				handleConnectionLoss(taskId);
			} else {
				activeConnections.delete(taskId);
			}
		});

		// Wait for connection to establish
		appendTerminalBuffer(taskId, `[system] Waiting for shell to initialize...\r\n`);
		await new Promise((resolve) => setTimeout(resolve, 5000));

		// Switch to VM user
		const vmUser = await configService.get('vm.user', 'agent', 'VM_USER');
		appendTerminalBuffer(taskId, `[system] Switching to ${vmUser} user...\r\n`);
		conn.write(`sudo su - ${vmUser}\n`);
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Start session as VM user (tmux preferred, screen fallback for backwards compatibility)
		appendTerminalBuffer(taskId, `[system] Creating persistent session: ${tmuxSession}\r\n`);
		conn.write(`tmux new-session -d -s ${tmuxSession} 2>/dev/null || screen -dmS ${tmuxSession}\n`);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		conn.write(`tmux attach-session -t ${tmuxSession} 2>/dev/null || screen -r ${tmuxSession}\n`);
		await new Promise((resolve) => setTimeout(resolve, 2000));

		connState.status = 'connected';

		// Clone repository and run agent
		const branchName = await generateBranchName(task);
		appendTerminalBuffer(taskId, `\r\n========================================\r\n`);
		appendTerminalBuffer(taskId, `[system] Executing setup commands\r\n`);
		appendTerminalBuffer(taskId, `[system] Repository: ${task.repository}\r\n`);
		appendTerminalBuffer(taskId, `[system] Branch: ${branchName}\r\n`);
		appendTerminalBuffer(taskId, `========================================\r\n\r\n`);

		// Build commands based on CLI type
		const cliSetupCommands = generateCliSetupCommands(
			task.coding_cli,
			task.vm_external_ip,
			task.system_prompt,
			vmUser
		);
		const agentStartCommand = generateAgentStartCommand(task.coding_cli, task.system_prompt);
		const repoPath = extractRepoPath(task.repository);

		const commands: Array<{
			cmd: string;
			desc: string;
			isAgentStart?: boolean;
			statusAfter?: string;
		}> = [
			{ cmd: `cd ~`, desc: 'Changing to home directory' },
			// Verify CLI installation (startup script already completed via SSH)
			{
				cmd: `source ~/.bashrc && node --version && ${task.coding_cli === 'claude-code' ? 'claude --version' : task.coding_cli === 'gemini' ? 'gemini --version' : 'codex --version'}`,
				desc: 'Verifying CLI installation',
				statusAfter: 'cloning',
			},
			// Reload tmux config now that startup script has completed
			{
				cmd: `tmux source-file ~/.tmux.conf 2>/dev/null && echo "Tmux config loaded (mouse support enabled)" || echo "Tmux config not found, using defaults"`,
				desc: 'Loading tmux configuration',
			},
			// Setup CLI and environment
			...cliSetupCommands,
			// Clone using git credential helper (configured during startup)
			{ cmd: `git clone https://gitlab.com/${repoPath}.git workspace`, desc: 'Cloning repository' },
			{ cmd: `cd workspace`, desc: 'Entering workspace' },
			// Configure git identity and pre-commit hooks
			...generateGitConfigCommands(),
			{ cmd: `git checkout -b ${branchName}`, desc: 'Creating feature branch' },
			{
				cmd: agentStartCommand,
				desc: `Starting ${task.coding_cli} agent`,
				isAgentStart: true,
				statusAfter: 'running',
			},
		];

		for (let i = 0; i < commands.length; i++) {
			const { cmd, desc, isAgentStart, statusAfter } = commands[i];
			appendTerminalBuffer(taskId, `\r\n[step ${i + 1}/${commands.length}] ${desc}\r\n`);
			appendTerminalBuffer(taskId, `$ ${cmd}\r\n`);
			conn.write(`${cmd}\n`);

			// Determine wait time based on command type
			let waitTime = 1000; // default
			if (cmd.includes('npm install')) {
				waitTime = 30000; // npm install can take a while
			} else if (cmd.includes('git clone')) {
				waitTime = 15000; // clone depends on repo size
			} else if (cmd.includes('while')) {
				waitTime = 60000; // waiting for startup script
			} else if (isAgentStart) {
				// Different CLIs have different startup times
				if (task.coding_cli === 'gemini') {
					waitTime = 15000; // Gemini takes longer to initialize (multiple phases)
				} else if (task.coding_cli === 'codex') {
					waitTime = 12000; // Codex also takes time to initialize
				} else {
					waitTime = 8000; // Claude Code is relatively quick
				}
			}
			await new Promise((resolve) => setTimeout(resolve, waitTime));

			// Update status after command if specified
			if (statusAfter) {
				await updateTaskStatus(taskId, statusAfter as import('../db/schema').TaskStatus);
			}

			// After starting the agent, send the initial task description via stdin
			if (isAgentStart) {
				appendTerminalBuffer(taskId, `\r\n[system] Sending initial task to agent...\r\n`);
				appendTerminalBuffer(taskId, `[user] ${task.task_description}\r\n`);
				// Send task description followed by Enter key (\r = carriage return, ASCII 13)
				conn.write(task.task_description);
				await new Promise((resolve) => setTimeout(resolve, 500));
				// Send Enter key as carriage return (what terminals send for Enter)
				conn.write('\r');
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}

		appendTerminalBuffer(taskId, `\r\n[system] Agent is now running interactively.\r\n`);
		appendTerminalBuffer(taskId, `[system] You can send follow-up instructions via the UI.\r\n`);
		appendTerminalBuffer(taskId, `========================================\r\n\r\n`);
	} catch (error) {
		const err = error as Error;
		appendTerminalBuffer(taskId, `[error] Failed to start task: ${err.message}\r\n`);
		await updateTaskStatus(taskId, 'failed');
		throw error;
	}
}

/**
 * Stop a running task and delete the VM
 */
export async function stopTask(taskId: string): Promise<void> {
	const task = await getTaskById(taskId);
	if (!task) {
		return;
	}

	appendTerminalBuffer(taskId, `\r\n========================================\r\n`);
	appendTerminalBuffer(taskId, `[system] Stopping task...\r\n`);

	// Set status to stopped FIRST to prevent onClose handler from setting it to 'completed'
	await updateTaskStatus(taskId, 'stopped');

	// Close active connection
	const connState = activeConnections.get(taskId);
	if (connState) {
		appendTerminalBuffer(taskId, `[system] Closing SSH connection...\r\n`);
		connState.status = 'disconnected';
		connState.conn.close();
		activeConnections.delete(taskId);
	}

	// Delete the VM if it exists
	if (task.vm_name) {
		appendTerminalBuffer(taskId, `[system] Deleting VM: ${task.vm_name}...\r\n`);
		try {
			await gcloud([
				'compute',
				'instances',
				'delete',
				task.vm_name,
				`--project=${env.GCP_PROJECT_ID}`,
				`--zone=${env.GCP_ZONE}`,
				'--quiet',
			]);
			appendTerminalBuffer(taskId, `[system] VM deleted successfully.\r\n`);
		} catch (error) {
			const err = error as Error;
			appendTerminalBuffer(taskId, `[system] Failed to delete VM: ${err.message}\r\n`);
			console.error(`Failed to delete VM ${task.vm_name}:`, error);
		}
	}

	appendTerminalBuffer(taskId, `[system] Task stopped.\r\n`);
	appendTerminalBuffer(taskId, `========================================\r\n`);
	await updateTaskStatus(taskId, 'stopped');
}

/**
 * Complete a task - mark as completed and delete the VM
 */
export async function completeTask(taskId: string): Promise<void> {
	const task = await getTaskById(taskId);
	if (!task) {
		return;
	}

	appendTerminalBuffer(taskId, `\r\n========================================\r\n`);
	appendTerminalBuffer(taskId, `[system] Completing task...\r\n`);

	// Set status to completed FIRST to prevent onClose handler from changing it
	await updateTaskStatus(taskId, 'completed');

	// Close active connection
	const connState = activeConnections.get(taskId);
	if (connState) {
		appendTerminalBuffer(taskId, `[system] Closing SSH connection...\r\n`);
		connState.status = 'disconnected';
		connState.conn.close();
		activeConnections.delete(taskId);
	}

	// Delete the VM if it exists
	if (task.vm_name) {
		appendTerminalBuffer(taskId, `[system] Deleting VM: ${task.vm_name}...\r\n`);
		try {
			await gcloud([
				'compute',
				'instances',
				'delete',
				task.vm_name,
				`--project=${env.GCP_PROJECT_ID}`,
				`--zone=${env.GCP_ZONE}`,
				'--quiet',
			]);
			appendTerminalBuffer(taskId, `[system] VM deleted successfully.\r\n`);
		} catch (error) {
			const err = error as Error;
			appendTerminalBuffer(taskId, `[system] Failed to delete VM: ${err.message}\r\n`);
			console.error(`Failed to delete VM ${task.vm_name}:`, error);
		}
	}

	appendTerminalBuffer(taskId, `[system] Task completed.\r\n`);
	appendTerminalBuffer(taskId, `========================================\r\n`);
}

/**
 * Send instruction to a running agent
 */
export async function sendInstruction(taskId: string, instruction: string): Promise<void> {
	const connState = activeConnections.get(taskId);
	if (!connState) {
		// Log debug info about active connections
		console.error(`[sendInstruction] No active connection for task ${taskId}`);
		console.error(
			`[sendInstruction] Active connections: ${Array.from(activeConnections.keys()).join(', ') || 'none'}`
		);
		throw new Error(
			'No active connection for task. The SSH session may have ended or the server was restarted.'
		);
	}

	if (connState.status !== 'connected') {
		console.error(
			`[sendInstruction] Connection not ready for task ${taskId}, status: ${connState.status}`
		);
		throw new Error(`Connection is ${connState.status}. Please wait for reconnection.`);
	}

	// Write instruction to the terminal
	console.log(`[sendInstruction] Sending to task ${taskId}: ${instruction}`);
	connState.conn.write(`${instruction}\n`);
	connState.lastActivity = new Date();
	appendTerminalBuffer(taskId, `\r\n[user] ${instruction}\r\n`);
}

/**
 * Resize the terminal (PTY) for a running task
 * This will automatically resize the tmux session to match
 */
export function resizeTerminal(taskId: string, cols: number, rows: number): void {
	const connState = activeConnections.get(taskId);
	if (!connState) {
		console.error(`[resizeTerminal] No active connection for task ${taskId}`);
		return;
	}

	if (connState.status !== 'connected') {
		console.error(
			`[resizeTerminal] Connection not ready for task ${taskId}, status: ${connState.status}`
		);
		return;
	}

	// Resize the PTY - this will automatically resize the tmux window
	// because tmux detects PTY size changes and adjusts accordingly
	console.log(`[resizeTerminal] Resizing PTY for task ${taskId} to ${cols}x${rows}`);
	connState.conn.resize(cols, rows);

	connState.lastActivity = new Date();
}

/**
 * Generate startup script for VM
 */
async function generateStartupScript(codingCli: string): Promise<string> {
	const vmUser = await configService.get('vm.user', 'agent', 'VM_USER');

	const baseScript = `#!/bin/bash
set -e

# Create ${vmUser} user
useradd -m -s /bin/bash ${vmUser} || true
usermod -aG sudo ${vmUser} || true
# Allow sudo without password for ${vmUser} user
echo "${vmUser} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${vmUser}
chmod 440 /etc/sudoers.d/${vmUser}

# Update system
apt-get update
apt-get install -y git curl wget tmux jq sudo

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install Python
apt-get install -y python3 python3-pip

# Install pre-commit
pip3 install pre-commit

# Install glab CLI for GitLab merge requests
curl -fsSL https://raw.githubusercontent.com/upciti/wakemeops/main/assets/install_repository | bash
apt-get install -y glab

# Configure tmux for ${vmUser} user for better scrolling and terminal experience
su - ${vmUser} -c "cat > ~/.tmux.conf <<'EOF'
# Enable mouse support for better scroll experience
set -g mouse on

# Increase scrollback buffer size
set -g history-limit 50000

# Use 256 colors
set -g default-terminal "screen-256color"

# Start window numbering at 1
set -g base-index 1

# Vi mode for copy mode
setw -g mode-keys vi

# Aggressive resize - only constrain window size for clients actively viewing it
# This prevents the "dots filling screen" issue when multiple clients with different sizes connect
setw -g aggressive-resize on
EOF
"

# Get service account for secret impersonation (if configured)
SECRET_IMPERSONATE_SA=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/SECRET_IMPERSONATE_SA" -H "Metadata-Flavor: Google" || true)
IMPERSONATE_FLAG=""
if [ -n "$SECRET_IMPERSONATE_SA" ]; then
    IMPERSONATE_FLAG="--impersonate-service-account=$SECRET_IMPERSONATE_SA"
    echo "Using service account impersonation for secrets: $SECRET_IMPERSONATE_SA"
    # Persist for later SSH sessions - /etc/environment for system-wide and bashrc for user shell
    echo "SECRET_IMPERSONATE_SA=$SECRET_IMPERSONATE_SA" >> /etc/environment
    echo "export SECRET_IMPERSONATE_SA=$SECRET_IMPERSONATE_SA" >> /home/${vmUser}/.bashrc
fi

# Configure git credentials from metadata for ${vmUser} user
# Resolve GitLab token from Secret Manager at runtime (more secure than passing in metadata)
GITLAB_TOKEN_SECRET=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/GITLAB_TOKEN_SECRET" -H "Metadata-Flavor: Google" || true)
if [ -n "$GITLAB_TOKEN_SECRET" ]; then
    echo "Resolving GitLab token from Secret Manager..."
    GITLAB_TOKEN=$(gcloud secrets versions access "$GITLAB_TOKEN_SECRET" $IMPERSONATE_FLAG 2>&1 | grep -v "^WARNING")
    if [ -z "$GITLAB_TOKEN" ] || echo "$GITLAB_TOKEN" | grep -qi "error|denied|permission"; then
        echo "Failed to resolve GitLab token: $GITLAB_TOKEN"
        GITLAB_TOKEN=""
    else
        echo "GitLab token resolved successfully"
    fi
fi
if [ -n "$GITLAB_TOKEN" ]; then
    # Configure git credential helper to use the token for ${vmUser} user
    su - ${vmUser} -c "git config --global credential.helper store"
    su - ${vmUser} -c "echo https://oauth2:\${GITLAB_TOKEN}@gitlab.com > ~/.git-credentials"
    su - ${vmUser} -c "chmod 600 ~/.git-credentials"
    # Authenticate glab CLI for ${vmUser} user
    su - ${vmUser} -c "glab auth login --token \${GITLAB_TOKEN} --hostname gitlab.com"
fi

# Configure git identity from metadata for ${vmUser} user
GIT_USER_NAME=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/GIT_USER_NAME" -H "Metadata-Flavor: Google" || echo "Coding Agent")
GIT_USER_EMAIL=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/GIT_USER_EMAIL" -H "Metadata-Flavor: Google")
su - ${vmUser} -c "git config --global user.name '$GIT_USER_NAME'"
if [ -n "$GIT_USER_EMAIL" ]; then
    su - ${vmUser} -c "git config --global user.email '$GIT_USER_EMAIL'"
fi

`;

	const cliScripts: Record<string, string> = {
		'claude-code': `
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Resolve Anthropic API key from Secret Manager at runtime (more secure)
ANTHROPIC_API_KEY_SECRET=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/ANTHROPIC_API_KEY_SECRET" -H "Metadata-Flavor: Google" || true)
if [ -n "$ANTHROPIC_API_KEY_SECRET" ]; then
    echo "Resolving Anthropic API key from Secret Manager..."
    export ANTHROPIC_API_KEY=$(gcloud secrets versions access "$ANTHROPIC_API_KEY_SECRET" $IMPERSONATE_FLAG 2>&1 | grep -v "^WARNING")
    if [ -z "$ANTHROPIC_API_KEY" ] || echo "$ANTHROPIC_API_KEY" | grep -qi "error|denied|permission"; then
        echo "Failed to resolve Anthropic API key: $ANTHROPIC_API_KEY"
        export ANTHROPIC_API_KEY=""
    else
        echo "Anthropic API key resolved successfully"
    fi
fi
echo "ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY}" >> /etc/environment
echo "export ANTHROPIC_API_KEY=\${ANTHROPIC_API_KEY}" >> /home/${vmUser}/.bashrc

# Install Playwright browsers for MCP
# Install system dependencies for Chromium
apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
# Install Chromium browser for Playwright
npx -y playwright@latest install chromium
`,
		gemini: `
# Install Gemini CLI with retry logic (npm registry can be flaky during VM startup)
for i in 1 2 3; do
    echo "Attempting to install Gemini CLI (attempt $i/3)..."
    if npm install -g @google/gemini-cli; then
        echo "Gemini CLI installed successfully"
        break
    else
        echo "Install attempt $i failed, retrying in 5 seconds..."
        sleep 5
    fi
done

# Add npm global bin to PATH for ${vmUser} user
NPM_BIN=$(npm config get prefix)/bin
echo "export PATH=\\$PATH:$NPM_BIN" >> /home/${vmUser}/.bashrc
echo "export PATH=\\$PATH:$NPM_BIN" >> /home/${vmUser}/.profile
chown ${vmUser}:${vmUser} /home/${vmUser}/.bashrc /home/${vmUser}/.profile

# Resolve Google API key from Secret Manager at runtime (if provided)
GOOGLE_API_KEY_SECRET=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/GOOGLE_API_KEY_SECRET" -H "Metadata-Flavor: Google" || true)
if [ -n "$GOOGLE_API_KEY_SECRET" ]; then
    echo "Resolving Google API key from Secret Manager..."
    GOOGLE_API_KEY=$(gcloud secrets versions access "$GOOGLE_API_KEY_SECRET" $IMPERSONATE_FLAG 2>&1 | grep -v "^WARNING" || echo "")
fi
if [ -n "$GOOGLE_API_KEY" ]; then
    export GOOGLE_API_KEY=\${GOOGLE_API_KEY}
    echo "export GOOGLE_API_KEY=\${GOOGLE_API_KEY}" >> /etc/environment
fi

# Configure ADC environment variables for Vertex AI (required for ADC authentication)
# These are required when GOOGLE_API_KEY is not set and Gemini uses the VM's service account
GOOGLE_CLOUD_PROJECT=$(curl -s "http://metadata.google.internal/computeMetadata/v1/project/project-id" -H "Metadata-Flavor: Google")
export GOOGLE_CLOUD_PROJECT=\${GOOGLE_CLOUD_PROJECT}
echo "export GOOGLE_CLOUD_PROJECT=\${GOOGLE_CLOUD_PROJECT}" >> /etc/environment
echo "export GOOGLE_CLOUD_PROJECT=\${GOOGLE_CLOUD_PROJECT}" >> /home/${vmUser}/.bashrc

# Set default location for Vertex AI (same zone as VM)
export GOOGLE_CLOUD_LOCATION=us-central1
echo "export GOOGLE_CLOUD_LOCATION=us-central1" >> /etc/environment
echo "export GOOGLE_CLOUD_LOCATION=us-central1" >> /home/${vmUser}/.bashrc

# Enable Vertex AI mode for Gemini CLI
export GOOGLE_GENAI_USE_VERTEXAI=true
echo "export GOOGLE_GENAI_USE_VERTEXAI=true" >> /etc/environment
echo "export GOOGLE_GENAI_USE_VERTEXAI=true" >> /home/${vmUser}/.bashrc

chown ${vmUser}:${vmUser} /home/${vmUser}/.bashrc

# Pre-configure Gemini CLI settings to use Vertex AI authentication
mkdir -p /home/${vmUser}/.gemini
cat > /home/${vmUser}/.gemini/settings.json << 'GEMINI_SETTINGS_EOF'
{
  "security": {
    "auth": {
      "selectedType": "vertex-ai"
    }
  }
}
GEMINI_SETTINGS_EOF
chown -R ${vmUser}:${vmUser} /home/${vmUser}/.gemini

# Note: If GOOGLE_API_KEY is not set, Gemini CLI will use Application Default Credentials (ADC)
# from the VM's service account, which requires:
# 1. The VM service account to have "Vertex AI User" IAM role
# 2. GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION to be set (configured above)
# 3. GOOGLE_GENAI_USE_VERTEXAI=true to enable Vertex AI mode
# 4. Pre-configured settings.json to select Vertex AI auth type
`,
		codex: `
# Install Codex CLI with retry logic (npm registry can be flaky during VM startup)
for i in 1 2 3; do
    echo "Attempting to install Codex CLI (attempt $i/3)..."
    if npm install -g @openai/codex; then
        echo "Codex CLI installed successfully"
        break
    else
        echo "Install attempt $i failed, retrying in 5 seconds..."
        sleep 5
    fi
done

# Add npm global bin to PATH for ${vmUser} user
NPM_BIN=$(npm config get prefix)/bin
echo "export PATH=\\$PATH:$NPM_BIN" >> /home/${vmUser}/.bashrc
echo "export PATH=\\$PATH:$NPM_BIN" >> /home/${vmUser}/.profile
chown ${vmUser}:${vmUser} /home/${vmUser}/.bashrc /home/${vmUser}/.profile

# Resolve OpenAI API key from Secret Manager at runtime (more secure)
OPENAI_API_KEY_SECRET=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/OPENAI_API_KEY_SECRET" -H "Metadata-Flavor: Google" || true)
if [ -n "$OPENAI_API_KEY_SECRET" ]; then
    echo "Resolving OpenAI API key from Secret Manager..."
    export OPENAI_API_KEY=$(gcloud secrets versions access "$OPENAI_API_KEY_SECRET" $IMPERSONATE_FLAG 2>&1 | grep -v "^WARNING")
fi
echo "export OPENAI_API_KEY=\${OPENAI_API_KEY}" >> /etc/environment
echo "export OPENAI_API_KEY=\${OPENAI_API_KEY}" >> /home/${vmUser}/.bashrc

# Pre-configure Codex CLI with API key authentication
mkdir -p /home/${vmUser}/.codex
chown -R ${vmUser}:${vmUser} /home/${vmUser}/.codex

# Pre-authenticate Codex CLI as ${vmUser} user using API key
# This creates ~/.codex/auth.json with cached credentials
if [ -n "$OPENAI_API_KEY" ]; then
    echo "Pre-authenticating Codex CLI with API key..."
    if su - ${vmUser} -c "echo $OPENAI_API_KEY | codex login --with-api-key"; then
        echo "Codex CLI successfully authenticated"
    else
        echo "WARNING: Codex pre-auth failed, will need to auth on first run"
    fi
else
    echo "WARNING: OPENAI_API_KEY not set, skipping Codex pre-auth"
fi

# Create config file to set approval mode preferences
cat > /home/${vmUser}/.codex/config.toml << 'CODEX_CONFIG_EOF'
# Codex CLI Configuration
# Auto-generated by Vibe Coding platform

# Credentials storage: file-based for VM environments
cli_auth_credentials_store = "file"

# Model selection (codex uses GPT-5-Codex by default)
# default_model = "gpt-5-codex"
CODEX_CONFIG_EOF
chown -R ${vmUser}:${vmUser} /home/${vmUser}/.codex

# Note: Codex uses --yolo flag (alias for --dangerously-bypass-approvals-and-sandbox)
# for autonomous operation in sandboxed VM environments
`,
	};

	return baseScript + (cliScripts[codingCli] || '');
}

/**
 * Deploy and execute startup script on VM via SSH
 * Provides real-time streaming output to terminal buffer
 */
async function deployAndExecuteStartupScript(
	taskId: string,
	vmName: string,
	codingCli: string,
	zone: string,
	project: string
): Promise<void> {
	// 1. Generate startup script
	const startupScript = await generateStartupScript(codingCli);

	// 2. Write to local temp file
	const localScriptPath = join(tmpdir(), `vibe-startup-${taskId}.sh`);
	writeFileSync(localScriptPath, startupScript, { mode: 0o755 });

	try {
		// 3. Copy to VM
		const remoteScriptPath = '/tmp/vibe-startup.sh';
		appendTerminalBuffer(taskId, '[system] Copying startup script to VM...\r\n');
		await copyToVM(vmName, localScriptPath, remoteScriptPath, zone, project);

		// 4. Make executable
		await execOnVM(vmName, `chmod +x ${remoteScriptPath}`, zone, project);

		// 5. Execute with streaming
		appendTerminalBuffer(taskId, '[system] Executing startup script...\r\n\r\n');

		const startTime = Date.now();

		const result = await execOnVMStreaming(
			vmName,
			`sudo ${remoteScriptPath}`,
			(data: string, stream: 'stdout' | 'stderr') => {
				const prefix = stream === 'stderr' ? '[startup:err] ' : '[startup] ';
				const normalized = data.replace(/\r?\n/g, '\r\n');
				const lines = normalized.split('\r\n');
				lines.forEach((line) => {
					if (line.trim()) {
						appendTerminalBuffer(taskId, `${prefix}${line}\r\n`);
					}
				});
			},
			zone,
			project,
			300000 // 5 minute timeout
		);

		const duration = ((Date.now() - startTime) / 1000).toFixed(1);

		if (result.exitCode !== 0) {
			appendTerminalBuffer(
				taskId,
				`\r\n[error] Startup script failed with exit code ${result.exitCode}\r\n`
			);
			throw new Error(`Startup script failed with exit code ${result.exitCode}`);
		}

		appendTerminalBuffer(
			taskId,
			`\r\n[system] Startup script completed successfully in ${duration}s\r\n\r\n`
		);

		// 6. Cleanup remote script
		await execOnVM(vmName, `rm -f ${remoteScriptPath}`, zone, project);
	} finally {
		// 7. Cleanup local temp file
		try {
			unlinkSync(localScriptPath);
		} catch {}
	}
}

/**
 * Load MCP configuration from vibe-coding/mcp-config.json
 * Returns base64 encoded config or null if file doesn't exist
 */
function loadMcpConfig(): string | null {
	const mcpConfigPath = resolve(process.cwd(), 'vibe-coding', 'mcp-config.json');
	if (!existsSync(mcpConfigPath)) {
		console.warn(`MCP config not found at ${mcpConfigPath}`);
		return null;
	}
	try {
		const configContent = readFileSync(mcpConfigPath, 'utf-8');
		// Validate JSON
		JSON.parse(configContent);
		// Base64 encode for safe transmission
		return Buffer.from(configContent).toString('base64');
	} catch (error) {
		console.error(`Failed to load MCP config: ${error}`);
		return null;
	}
}

/**
 * Generate CLI setup commands (install CLI and set env vars)
 */
function generateCliSetupCommands(
	codingCli: string,
	_vmExternalIp: string | null,
	systemPrompt: string | null | undefined,
	vmUser: string
): Array<{ cmd: string; desc: string }> {
	// Common setup commands - resolve GitLab token from Secret Manager and load git user
	const commonCommands: Array<{ cmd: string; desc: string }> = [
		{
			cmd: `GITLAB_TOKEN_SECRET=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/GITLAB_TOKEN_SECRET" -H "Metadata-Flavor: Google") && IMPERSONATE_FLAG="" && [ -n "$SECRET_IMPERSONATE_SA" ] && IMPERSONATE_FLAG="--impersonate-service-account=$SECRET_IMPERSONATE_SA" && export GITLAB_TOKEN=$(gcloud secrets versions access "$GITLAB_TOKEN_SECRET" $IMPERSONATE_FLAG 2>&1 | grep -v "^WARNING")`,
			desc: 'Resolving GitLab token from Secret Manager',
		},
		{
			cmd: `export GIT_USER=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/GIT_USER" -H "Metadata-Flavor: Google")`,
			desc: 'Loading git user from VM metadata',
		},
	];

	// Load MCP configuration
	const mcpConfigBase64 = loadMcpConfig();

	const cliCommands: Record<string, Array<{ cmd: string; desc: string }>> = {
		'claude-code': [
			{
				cmd: `command -v claude || sudo npm install -g @anthropic-ai/claude-code`,
				desc: 'Installing Claude Code CLI',
			},
			{
				cmd: `ANTHROPIC_API_KEY_SECRET=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/ANTHROPIC_API_KEY_SECRET" -H "Metadata-Flavor: Google") && IMPERSONATE_FLAG="" && [ -n "$SECRET_IMPERSONATE_SA" ] && IMPERSONATE_FLAG="--impersonate-service-account=$SECRET_IMPERSONATE_SA" && export ANTHROPIC_API_KEY=$(gcloud secrets versions access "$ANTHROPIC_API_KEY_SECRET" $IMPERSONATE_FLAG 2>&1 | grep -v "^WARNING")`,
				desc: 'Resolving ANTHROPIC_API_KEY from Secret Manager',
			},
			{
				// Create Claude Code config to skip onboarding, pre-approve the API key, and accept bypass permissions
				// The customApiKeyResponses.approved array needs last 20 chars of the API key
				// bypassPermissionsModeAccepted: true pre-accepts the --dangerously-skip-permissions warning
				cmd: `mkdir -p ~/.claude && API_KEY_SUFFIX=$(echo $ANTHROPIC_API_KEY | tail -c 21) && echo '{"numStartups":1,"theme":"dark","autoUpdaterStatus":"disabled","hasCompletedOnboarding":true,"shiftEnterKeyBindingInstalled":true,"bypassPermissionsModeAccepted":true,"customApiKeyResponses":{"approved":["'$API_KEY_SUFFIX'"],"rejected":[]}}' > ~/.claude.json`,
				desc: 'Creating Claude Code settings to skip login and onboarding',
			},
			// Deploy MCP configuration if available
			...(mcpConfigBase64
				? [
						{
							cmd: `echo "${mcpConfigBase64}" | base64 -d | jq -c '.mcpServers | to_entries[]' | while read entry; do name=$(echo "$entry" | jq -r '.key'); config=$(echo "$entry" | jq -c '.value'); claude mcp add-json "$name" "$config"; done`,
							desc: 'Installing MCP servers from vibe-coding/mcp-config.json',
						},
					]
				: []),
		],
		gemini: [
			{
				cmd: `GOOGLE_API_KEY_SECRET=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/GOOGLE_API_KEY_SECRET" -H "Metadata-Flavor: Google" || true) && if [ -n "$GOOGLE_API_KEY_SECRET" ]; then IMPERSONATE_FLAG="" && [ -n "$SECRET_IMPERSONATE_SA" ] && IMPERSONATE_FLAG="--impersonate-service-account=$SECRET_IMPERSONATE_SA"; export GOOGLE_API_KEY=$(gcloud secrets versions access "$GOOGLE_API_KEY_SECRET" $IMPERSONATE_FLAG 2>&1 | grep -v "^WARNING"); fi`,
				desc: 'Resolving Google API key from Secret Manager (if available)',
			},
			{
				cmd: `export GOOGLE_CLOUD_PROJECT=$(curl -s "http://metadata.google.internal/computeMetadata/v1/project/project-id" -H "Metadata-Flavor: Google")`,
				desc: 'Setting GOOGLE_CLOUD_PROJECT for ADC authentication',
			},
			{
				cmd: `export GOOGLE_CLOUD_LOCATION=us-central1`,
				desc: 'Setting GOOGLE_CLOUD_LOCATION for Vertex AI',
			},
			{
				cmd: `export GOOGLE_GENAI_USE_VERTEXAI=true`,
				desc: 'Enabling Vertex AI mode for Gemini CLI',
			},
			...(systemPrompt
				? [
						{
							cmd: `mkdir -p ~/workspace/.gemini && cat > ~/workspace/.gemini/system.md << 'SYSTEM_PROMPT_EOF'
${systemPrompt.replace(/'/g, "'\\''")}
SYSTEM_PROMPT_EOF`,
							desc: 'Configuring custom system prompt for Gemini',
						},
					]
				: []),
			{
				cmd: `command -v gemini && echo "Gemini CLI is available in PATH" || echo "WARNING: Gemini CLI not found - check startup script"`,
				desc: 'Verifying Gemini CLI installation',
			},
		],
		codex: [
			{
				cmd: `OPENAI_API_KEY_SECRET=$(curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/OPENAI_API_KEY_SECRET" -H "Metadata-Flavor: Google") && IMPERSONATE_FLAG="" && [ -n "$SECRET_IMPERSONATE_SA" ] && IMPERSONATE_FLAG="--impersonate-service-account=$SECRET_IMPERSONATE_SA" && export OPENAI_API_KEY=$(gcloud secrets versions access "$OPENAI_API_KEY_SECRET" $IMPERSONATE_FLAG 2>&1 | grep -v "^WARNING")`,
				desc: 'Resolving OPENAI_API_KEY from Secret Manager',
			},
			...(systemPrompt
				? [
						{
							cmd: `mkdir -p ~/.codex && cat > ~/.codex/instructions.md << 'SYSTEM_PROMPT_EOF'
${systemPrompt.replace(/'/g, "'\\''")}
SYSTEM_PROMPT_EOF
echo 'experimental_instructions_file = "/home/${vmUser}/.codex/instructions.md"' >> ~/.codex/config.toml`,
							desc: 'Configuring custom system prompt for Codex',
						},
					]
				: []),
			{
				cmd: `command -v codex && echo "Codex CLI is available in PATH" || echo "WARNING: Codex CLI not found - check startup script"`,
				desc: 'Verifying Codex CLI installation',
			},
		],
	};

	return [...commonCommands, ...(cliCommands[codingCli] || [])];
}

/**
 * Generate the command to start the coding agent (in interactive mode)
 * Note: The initial task is sent separately via stdin after the agent starts
 */
function generateAgentStartCommand(codingCli: string, systemPrompt?: string | null): string {
	const escapedPrompt = systemPrompt?.replace(/"/g, '\\"') || '';

	const commands: Record<string, string> = {
		// Start Claude in interactive mode with --dangerously-skip-permissions
		// The initial prompt will be sent via stdin after startup
		'claude-code': `claude --dangerously-skip-permissions${escapedPrompt ? ` --system-prompt "${escapedPrompt}"` : ''}`,
		// Gemini with --yolo flag for autonomous operation
		// Auto-routing will select best model (Gemini 3 Pro/Flash) based on task complexity
		// Will use Application Default Credentials if GOOGLE_API_KEY not set
		gemini: `gemini --yolo`,
		// Codex with --yolo flag (alias for --dangerously-bypass-approvals-and-sandbox)
		// Runs without approval prompts for autonomous operation
		codex: `codex --yolo`,
	};

	return commands[codingCli] || `echo "Unknown CLI: ${codingCli}"`;
}

/**
 * Generate git post-clone configuration commands
 * Installs pre-commit hooks and verifies git identity
 */
function generateGitConfigCommands(): Array<{ cmd: string; desc: string }> {
	return [
		{
			cmd: `git config user.name`,
			desc: 'Verifying git user name',
		},
		{
			cmd: `git config user.email`,
			desc: 'Verifying git user email',
		},
		{
			cmd: `if [ -f .pre-commit-config.yaml ]; then pre-commit install && echo "Pre-commit hooks installed"; else echo "No .pre-commit-config.yaml found, skipping"; fi`,
			desc: 'Installing pre-commit hooks if configured',
		},
	];
}
