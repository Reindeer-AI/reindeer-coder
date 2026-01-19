import * as vscode from 'vscode';
import { type Task, VibeClient } from './api/vibe-client';
import { Auth0Client } from './auth/auth0-client';
import { SSHFSManager } from './connection/sshfs-manager';
import { TerminalManager } from './connection/terminal-manager';
import { type TaskTreeItem, TaskTreeProvider } from './views/task-tree-provider';

let auth0Client: Auth0Client;
let vibeClient: VibeClient;
let taskTreeProvider: TaskTreeProvider;
let sshfsManager: SSHFSManager;
let terminalManager: TerminalManager;
let outputChannel: vscode.OutputChannel;

// Track snapshot terminals by task ID
interface SnapshotTerminalState {
	terminal: vscode.Terminal;
	writeEmitter: vscode.EventEmitter<string>;
	closeEmitter: vscode.EventEmitter<void>;
}
const snapshotTerminals = new Map<string, SnapshotTerminalState>();

// Track SSH terminal connections to VMs
interface TerminalVMInfo {
	vmName: string;
	zone: string;
	project: string;
	taskId: string;
}
const terminalVMMap = new Map<vscode.Terminal, TerminalVMInfo>();

export async function activate(context: vscode.ExtensionContext) {
	console.log('Reindeer Coder extension is now active');

	// Create output channel
	outputChannel = vscode.window.createOutputChannel('Reindeer Coder');
	outputChannel.show(); // Show output channel on activation for debugging
	outputChannel.appendLine('='.repeat(80));
	outputChannel.appendLine('Reindeer Coder extension activated');
	outputChannel.appendLine(`Activation time: ${new Date().toISOString()}`);
	outputChannel.appendLine('='.repeat(80));

	// Get configuration
	const config = vscode.workspace.getConfiguration('reindeerCoder');
	const apiUrl = config.get<string>('apiUrl', 'https://vibe.reindeerlabs.ai');
	const auth0Domain = config.get<string>('auth0Domain', 'dev-0d0uyl2iqc17144b.us.auth0.com');
	const auth0ClientId = config.get<string>('auth0ClientId', 'i6QxH7zvtkkm5pD1iCS4mcIavVXhuOiZ');
	const auth0Audience = config.get<string>('auth0Audience', 'https://vibe.reindeerlabs.ai');
	const auth0OrganizationId = config.get<string>('auth0OrganizationId', 'org_9WU9bq88J0jAPjmM');
	const gcpProject = config.get<string>('gcpProject', 'reindeer-vibe');
	const mountPath = config.get<string>('mountPath', '~/reindeer-coder-mounts');

	outputChannel.appendLine('\n[CONFIG] Loading configuration...');
	outputChannel.appendLine(`  API URL: ${apiUrl}`);
	outputChannel.appendLine(`  Auth0 Domain: ${auth0Domain}`);
	outputChannel.appendLine(`  Auth0 Client ID: ${auth0ClientId}`);
	outputChannel.appendLine(`  Auth0 Audience: ${auth0Audience}`);
	outputChannel.appendLine(`  Auth0 Organization: ${auth0OrganizationId || '(none)'}`);
	outputChannel.appendLine(`  GCP Project: ${gcpProject}`);
	outputChannel.appendLine(`  Mount Path: ${mountPath}`);

	// Validate Auth0 configuration
	if (!auth0ClientId) {
		const errorMsg =
			'Auth0 Client ID is not configured. Please set reindeerCoder.auth0ClientId in settings.';
		outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
		vscode.window.showErrorMessage(`Reindeer Coder: ${errorMsg}`);
		return;
	}

	outputChannel.appendLine('\n[AUTH] Initializing Auth0 client...');

	// Initialize Auth0 client
	auth0Client = new Auth0Client(
		context,
		auth0Domain,
		auth0ClientId,
		auth0Audience,
		auth0OrganizationId || undefined
	);

	outputChannel.appendLine('[AUTH] Auth0 client initialized');

	// Initialize Reindeer Coder API client
	outputChannel.appendLine('\n[API] Initializing Reindeer Coder API client...');
	outputChannel.appendLine(`  API URL: ${apiUrl}`);
	vibeClient = new VibeClient(apiUrl, () => auth0Client.getAccessToken());

	// Set up auth error handler to automatically trigger login on 401
	vibeClient.setAuthErrorHandler(async () => {
		outputChannel.appendLine('[AUTH] 401 error detected - triggering login flow');
		vscode.window
			.showWarningMessage('Authentication expired. Please log in again.', 'Login')
			.then(async (selection) => {
				if (selection === 'Login') {
					const success = await auth0Client.login();
					if (success) {
						await checkAuthAndLoadTasks();
					}
				}
			});
	});

	outputChannel.appendLine('[API] Reindeer Coder API client initialized');

	// Initialize managers
	outputChannel.appendLine('\n[INIT] Initializing managers...');
	sshfsManager = new SSHFSManager(outputChannel);
	terminalManager = new TerminalManager(outputChannel);
	outputChannel.appendLine('[INIT] Managers initialized');

	// Initialize tree view
	outputChannel.appendLine('\n[UI] Initializing tree view...');
	taskTreeProvider = new TaskTreeProvider();
	const treeView = vscode.window.createTreeView('reindeerCoderTasks', {
		treeDataProvider: taskTreeProvider,
	});
	context.subscriptions.push(treeView);
	outputChannel.appendLine('[UI] Tree view initialized');

	// Check authentication status and load tasks
	outputChannel.appendLine('\n[AUTH] Checking authentication status...');
	await checkAuthAndLoadTasks();

	// Background polling disabled - it interferes with tmux sessions
	// Terminal snapshots are fetched on-demand when user views/refreshes them
	// Connections are kept alive via SSH keepalive (ServerAliveInterval=30)
	outputChannel.appendLine('\n[POLLING] Background polling disabled');

	// const pollingInterval = setInterval(async () => {
	// 	try {
	// 		const isAuth = await auth0Client.isAuthenticated();
	// 		if (!isAuth) {
	// 			return; // Skip polling if not authenticated
	// 		}
	//
	// 		// Get all running tasks
	// 		const tasks = await vibeClient.listActiveTasks();
	// 		if (tasks.length === 0) {
	// 			return; // No running tasks, skip polling
	// 		}
	//
	// 		outputChannel.appendLine(
	// 			`[POLLING] Refreshing terminal snapshots for ${tasks.length} running tasks...`
	// 		);
	//
	// 		// Fetch terminal snapshots in the background to keep connections alive
	// 		// Use Promise.allSettled to run all requests in parallel without waiting
	// 		const snapshotPromises = tasks.map((task) =>
	// 			vibeClient
	// 				.getTerminalSnapshot(task.id)
	// 				.then(() => {
	// 					outputChannel.appendLine(`[POLLING] ✓ Task ${task.id.substring(0, 8)}`);
	// 				})
	// 				.catch((error: any) => {
	// 					// Silent fail - don't show errors to user for background polling
	// 					const errorMsg = error?.message || error?.toString() || 'Unknown error';
	// 					outputChannel.appendLine(`[POLLING] ✗ Task ${task.id.substring(0, 8)}: ${errorMsg}`);
	// 				})
	// 		);
	//
	// 		// Wait for all snapshot requests to complete (or timeout)
	// 		await Promise.allSettled(snapshotPromises);
	// 	} catch (error) {
	// 		outputChannel.appendLine(`[POLLING] Error during background poll: ${error}`);
	// 	}
	// }, 300000); // Poll every 5 minutes (300,000 ms)
	//
	// // Clean up polling on deactivation
	// context.subscriptions.push({
	// 	dispose: () => {
	// 		clearInterval(pollingInterval);
	// 		outputChannel.appendLine('[POLLING] Background polling stopped');
	// 	},
	// });

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.login', async () => {
			outputChannel.appendLine('\n[COMMAND] Login command triggered');
			outputChannel.show();
			const success = await auth0Client.login();
			outputChannel.appendLine(`[AUTH] Login result: ${success ? 'SUCCESS' : 'FAILED'}`);
			if (success) {
				await checkAuthAndLoadTasks();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.logout', async () => {
			outputChannel.appendLine('\n[COMMAND] Logout command triggered');
			await auth0Client.logout();
			taskTreeProvider.setAuthenticated(false);
			taskTreeProvider.setTasks([]);
			outputChannel.appendLine('[AUTH] Logged out successfully');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.refreshTasks', async () => {
			outputChannel.appendLine('\n[COMMAND] Refresh tasks command triggered');
			await loadTasks();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.showDebugInfo', async () => {
			outputChannel.show();
			outputChannel.appendLine(`\n${'='.repeat(80)}`);
			outputChannel.appendLine('[DEBUG] Debug Information');
			outputChannel.appendLine('='.repeat(80));

			const isAuth = await auth0Client.isAuthenticated();
			const token = await auth0Client.getAccessToken();

			outputChannel.appendLine(
				`\nAuthentication Status: ${isAuth ? 'AUTHENTICATED' : 'NOT AUTHENTICATED'}`
			);
			outputChannel.appendLine(`Token Present: ${token ? 'YES' : 'NO'}`);
			if (token) {
				outputChannel.appendLine(`Token Length: ${token.length} chars`);
				outputChannel.appendLine(`Token Preview: ${token.substring(0, 20)}...`);
			}

			outputChannel.appendLine(`\nConfiguration:`);
			const config = vscode.workspace.getConfiguration('reindeerCoder');
			outputChannel.appendLine(`  API URL: ${config.get('apiUrl')}`);
			outputChannel.appendLine(`  Auth0 Domain: ${config.get('auth0Domain')}`);
			outputChannel.appendLine(`  Auth0 Client ID: ${config.get('auth0ClientId')}`);
			outputChannel.appendLine(`  Auth0 Audience: ${config.get('auth0Audience')}`);
			outputChannel.appendLine(`  Auth0 Organization: ${config.get('auth0OrganizationId')}`);
			outputChannel.appendLine(`  GCP Project: ${config.get('gcpProject')}`);

			outputChannel.appendLine('='.repeat(80));

			vscode.window.showInformationMessage('Debug info written to Reindeer Coder output channel');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.connectTask', async (item: TaskTreeItem) => {
			await connectToTask(item.task.id, gcpProject, mountPath);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'reindeerCoder.connectTerminalOnly',
			async (item: TaskTreeItem) => {
				await connectTerminalOnly(item.task.id, gcpProject);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.disconnectTask', async (taskId: string) => {
			await disconnectFromTask(taskId);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'reindeerCoder.viewTerminalSnapshot',
			async (taskId: string) => {
				await viewTerminalSnapshot(taskId);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'reindeerCoder.refreshTerminalSnapshot',
			async (taskId: string) => {
				await refreshTerminalSnapshot(taskId);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.sendTextToTerminal', async (taskId: string) => {
			await sendTextToTerminal(taskId);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.showTaskDetails', async (taskId: string) => {
			await showTaskDetails(taskId);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.switchTmuxSession', async () => {
			await switchTmuxSession();
		})
	);

	// Note: Tree item clicks now handled by inline buttons instead of selection event

	// Listen for terminal close events to clean up VM mapping
	context.subscriptions.push(
		vscode.window.onDidCloseTerminal((terminal) => {
			if (terminalVMMap.has(terminal)) {
				outputChannel.appendLine(`[CLEANUP] Removing VM mapping for closed terminal`);
				terminalVMMap.delete(terminal);
			}
		})
	);

	// Clean up on deactivation
	context.subscriptions.push({
		dispose: async () => {
			await sshfsManager.unmountAll();
			terminalManager.disconnectAll();
			outputChannel.dispose();
		},
	});
}

/**
 * Check authentication and load tasks
 */
async function checkAuthAndLoadTasks(): Promise<void> {
	try {
		const isAuthenticated = await auth0Client.isAuthenticated();
		outputChannel.appendLine(`[AUTH] Is authenticated: ${isAuthenticated}`);

		if (isAuthenticated) {
			const token = await auth0Client.getAccessToken();
			outputChannel.appendLine(`[AUTH] Token retrieved: ${token ? 'YES' : 'NO'}`);
			if (token) {
				outputChannel.appendLine(`[AUTH] Token preview: ${token.substring(0, 20)}...`);
			}
		}

		taskTreeProvider.setAuthenticated(isAuthenticated);
		outputChannel.appendLine(`[UI] Tree provider auth status set to: ${isAuthenticated}`);

		if (isAuthenticated) {
			await loadTasks();
		} else {
			outputChannel.appendLine('[AUTH] Not authenticated - showing login prompt in tree view');
		}
	} catch (error) {
		outputChannel.appendLine(`[ERROR] checkAuthAndLoadTasks failed: ${error}`);
		if (error instanceof Error) {
			outputChannel.appendLine(`  Stack: ${error.stack}`);
		}
	}
}

/**
 * Load tasks from API
 */
async function loadTasks(): Promise<void> {
	try {
		outputChannel.appendLine('\n[API] Loading tasks...');
		const tasks = await vibeClient.listActiveTasks();
		outputChannel.appendLine(`[API] Received ${tasks.length} active tasks`);

		if (tasks.length > 0) {
			outputChannel.appendLine('[API] Task details:');
			tasks.forEach((task, i) => {
				const desc = task.task_description
					? task.task_description.split('\n')[0].substring(0, 40)
					: '(no description)';
				outputChannel.appendLine(
					`  ${i + 1}. ${task.id.substring(0, 8)} - ${task.status} - ${desc}`
				);
				outputChannel.appendLine(
					`     VM: ${task.vm_name || 'not assigned'} (${task.vm_zone || 'no zone'})`
				);
				outputChannel.appendLine(`     Repo: ${task.repository || 'not set'}`);
				outputChannel.appendLine(
					`     Description type: ${typeof task.task_description}, value: ${task.task_description ? 'present' : 'null/undefined'}`
				);
			});
		}

		taskTreeProvider.setTasks(tasks);
		outputChannel.appendLine(`[UI] Tree view updated with ${tasks.length} tasks`);
	} catch (error) {
		outputChannel.appendLine(`\n[ERROR] Failed to load tasks: ${error}`);
		if (error instanceof Error) {
			outputChannel.appendLine(`  Message: ${error.message}`);
			outputChannel.appendLine(`  Stack: ${error.stack}`);
		}
		vscode.window.showErrorMessage(`Failed to load tasks: ${error}`);
	}
}

/**
 * Create workspace configuration files for the mounted workspace
 */
async function createWorkspaceConfig(
	workspacePath: string,
	options: { taskId: string; vmName: string; zone: string; project: string; tmuxSession: string }
): Promise<void> {
	const fs = require('node:fs').promises;
	const path = require('node:path');

	try {
		// Create .vscode directory
		const vscodeDir = path.join(workspacePath, '.vscode');
		await fs.mkdir(vscodeDir, { recursive: true });

		// Create tasks.json with SSH connection task
		const tasksConfig = {
			version: '2.0.0',
			tasks: [
				{
					label: 'Connect to Reindeer Session',
					type: 'shell',
					command: `gcloud compute ssh ${options.vmName} --project=${options.project} --zone=${options.zone} --tunnel-through-iap --ssh-flag="-t" -- sudo -u reindeer-vibe tmux attach-session -t ${options.tmuxSession}`,
					problemMatcher: [],
					presentation: {
						reveal: 'always',
						panel: 'new',
						focus: true,
					},
					runOptions: {
						runOn: 'folderOpen',
					},
				},
			],
		};

		const tasksPath = path.join(vscodeDir, 'tasks.json');
		await fs.writeFile(tasksPath, JSON.stringify(tasksConfig, null, 2));

		// Create settings.json to auto-run the task
		const settingsConfig = {
			'task.autoDetect': 'on',
			'terminal.integrated.defaultProfile.linux': 'bash',
			'terminal.integrated.defaultProfile.osx': 'bash',
		};

		const settingsPath = path.join(vscodeDir, 'settings.json');
		await fs.writeFile(settingsPath, JSON.stringify(settingsConfig, null, 2));

		outputChannel.appendLine(`Created workspace configuration in ${vscodeDir}`);
	} catch (error) {
		outputChannel.appendLine(`Warning: Failed to create workspace config: ${error}`);
		// Don't throw - this is not critical
	}
}

/**
 * Generate a meaningful folder name from task details
 */
function generateTaskFolderName(task: Task): string {
	const shortId = task.id.substring(0, 8);

	// Try to use first 20 chars of task description (prioritize this)
	if (task.task_description && typeof task.task_description === 'string') {
		const firstLine = task.task_description.split('\n')[0].trim();
		if (firstLine) {
			// Sanitize: lowercase, replace spaces/special chars with dashes, limit to 20 chars
			const sanitized = firstLine
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-+|-+$/g, '')
				.substring(0, 20);
			if (sanitized) {
				return `${sanitized}-${shortId}`;
			}
		}
	}

	// Fall back to repo name if no description
	if (task.repository) {
		const repoMatch = task.repository.match(/\/([^/]+?)(\.git)?$/);
		if (repoMatch) {
			const repoName = repoMatch[1];
			return `${repoName}-${shortId}`;
		}
	}

	// Final fallback to just the short ID
	return shortId;
}

/**
 * Connect to a task (mount filesystem and open terminal)
 */
async function connectToTask(
	taskId: string,
	gcpProject: string,
	mountBasePath: string
): Promise<void> {
	try {
		outputChannel.appendLine(`Connecting to task ${taskId.substring(0, 8)}...`);

		// Get task details
		const taskDetails = await vibeClient.getTask(taskId);

		if (!taskDetails.vm_name || !taskDetails.vm_zone) {
			throw new Error('Task does not have VM information');
		}

		// Generate meaningful folder name
		const folderName = generateTaskFolderName(taskDetails);
		outputChannel.appendLine(`Using mount folder name: ${folderName}`);

		// Show progress
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Connecting to ${folderName}`,
				cancellable: false,
			},
			async (progress) => {
				// Mount filesystem
				progress.report({ message: 'Mounting remote filesystem...' });

				// Expand tilde in mount path and use meaningful folder name
				const expandedBasePath = mountBasePath.replace(/^~/, require('node:os').homedir());
				const localPath = require('node:path').join(expandedBasePath, folderName);

				const mountedPath = await sshfsManager.mount(taskId, {
					vmName: taskDetails.vm_name!,
					zone: taskDetails.vm_zone!,
					project: gcpProject,
					remotePath: taskDetails.workspace_path || '/home/reindeer-vibe/workspace',
					localPath: localPath,
				});

				// Create VS Code workspace configuration with terminal task
				progress.report({ message: 'Creating workspace configuration...' });
				await createWorkspaceConfig(mountedPath, {
					taskId,
					vmName: taskDetails.vm_name!,
					zone: taskDetails.vm_zone!,
					project: gcpProject,
					tmuxSession: taskDetails.tmux_session || `coder-${taskId.substring(0, 8)}`,
				});

				// Open workspace in NEW window
				progress.report({ message: 'Opening workspace...' });
				const uri = vscode.Uri.file(mountedPath);
				await vscode.commands.executeCommand('vscode.openFolder', uri, {
					forceNewWindow: true,
				});

				vscode.window.showInformationMessage(
					`Connected to ${folderName}. Use Terminal > Run Task > "Connect to Reindeer Session" to open the remote terminal.`
				);
			}
		);
	} catch (error) {
		outputChannel.appendLine(`Failed to connect to task: ${error}`);
		vscode.window.showErrorMessage(`Failed to connect to task: ${error}`);
	}
}

/**
 * Connect to task terminal only (no workspace mount, opens in current window)
 */
async function connectTerminalOnly(taskId: string, gcpProject: string): Promise<void> {
	try {
		outputChannel.appendLine(`Opening terminal for task ${taskId.substring(0, 8)}...`);

		// Get task details
		const taskDetails = await vibeClient.getTask(taskId);

		if (!taskDetails.vm_name || !taskDetails.vm_zone) {
			throw new Error('Task does not have VM information');
		}

		const shortId = taskId.substring(0, 8);
		const tmuxSession = taskDetails.tmux_session || `coder-${shortId}`;

		// Build SSH command with correct flags and sudo to reindeer-vibe user
		const sshCommand = [
			'gcloud',
			'compute',
			'ssh',
			taskDetails.vm_name,
			`--project=${gcpProject}`,
			`--zone=${taskDetails.vm_zone}`,
			'--tunnel-through-iap',
			'--ssh-flag="-t"',
			'--',
			'sudo -u reindeer-vibe',
			`tmux attach-session -t ${tmuxSession}`,
		].join(' ');

		// Create terminal with task description as name (truncated to 40 chars)
		const terminalName = taskDetails.task_description
			? `Terminal - ${taskDetails.task_description.substring(0, 40)}${taskDetails.task_description.length > 40 ? '...' : ''}`
			: `Terminal - ${shortId}`;

		const terminal = vscode.window.createTerminal({
			name: terminalName,
			shellPath: '/bin/bash',
			shellArgs: ['-c', sshCommand],
		});

		// Track terminal -> VM mapping for tmux session switching
		terminalVMMap.set(terminal, {
			vmName: taskDetails.vm_name,
			zone: taskDetails.vm_zone!,
			project: gcpProject,
			taskId,
		});

		terminal.show();
		outputChannel.appendLine(`Opened terminal for task ${shortId} in current window`);

		vscode.window.showInformationMessage(`Connected terminal to task ${shortId}`);
	} catch (error) {
		outputChannel.appendLine(`Failed to connect terminal: ${error}`);
		vscode.window.showErrorMessage(`Failed to connect terminal: ${error}`);
	}
}

/**
 * Disconnect from a task (unmount filesystem and close terminal)
 */
async function disconnectFromTask(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(`Disconnecting from task ${taskId}...`);

		// Unmount filesystem
		await sshfsManager.unmount(taskId);

		// Disconnect terminal
		terminalManager.disconnect(taskId);

		vscode.window.showInformationMessage(`Disconnected from task ${taskId}`);
	} catch (error) {
		outputChannel.appendLine(`Failed to disconnect from task: ${error}`);
		vscode.window.showErrorMessage(`Failed to disconnect from task: ${error}`);
	}
}

/**
 * View terminal snapshot for a task (reuses existing terminal if available)
 */
async function viewTerminalSnapshot(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(
			`\n[COMMAND] View terminal snapshot for task ${taskId.substring(0, 8)}`
		);

		// Show progress
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Loading terminal snapshot...`,
				cancellable: false,
			},
			async (progress) => {
				// Fetch terminal snapshot
				progress.report({ message: 'Fetching terminal data...' });
				const terminalBuffer = await vibeClient.getTerminalSnapshot(taskId);

				if (!terminalBuffer) {
					vscode.window.showWarningMessage('No terminal snapshot available for this task');
					return;
				}

				// Get task details for terminal name
				const task = await vibeClient.getTask(taskId);
				const terminalName = task.task_description
					? `Snapshot - ${task.task_description.substring(0, 40)}${task.task_description.length > 40 ? '...' : ''}`
					: `Snapshot - ${taskId.substring(0, 8)}`;

				// Check if we already have a terminal for this task
				let terminalState = snapshotTerminals.get(taskId);

				// Check if terminal is still valid
				if (terminalState && terminalState.terminal.exitStatus !== undefined) {
					// Terminal was closed, remove it
					snapshotTerminals.delete(taskId);
					terminalState = undefined;
				}

				if (terminalState) {
					// Reuse existing terminal - clear and rewrite
					progress.report({ message: 'Updating terminal...' });
					outputChannel.appendLine(
						`[COMMAND] Reusing existing terminal for task ${taskId.substring(0, 8)}`
					);

					// Clear screen and move cursor to home
					terminalState.writeEmitter.fire('\x1b[2J\x1b[H');
					// Write new content
					terminalState.writeEmitter.fire(terminalBuffer);
					terminalState.writeEmitter.fire('\r\n\r\n--- End of snapshot ---\r\n');
					// Show the terminal
					terminalState.terminal.show();
				} else {
					// Create new terminal
					progress.report({ message: 'Opening terminal...' });
					outputChannel.appendLine(
						`[COMMAND] Creating new terminal for task ${taskId.substring(0, 8)}`
					);

					const writeEmitter = new vscode.EventEmitter<string>();
					const closeEmitter = new vscode.EventEmitter<void>();

					const pty: vscode.Pseudoterminal = {
						onDidWrite: writeEmitter.event,
						onDidClose: closeEmitter.event,
						open: () => {
							writeEmitter.fire(terminalBuffer);
							writeEmitter.fire('\r\n\r\n--- End of snapshot ---\r\n');
						},
						close: () => {
							closeEmitter.fire();
							// Clean up when terminal is closed
							snapshotTerminals.delete(taskId);
						},
					};

					const terminal = vscode.window.createTerminal({
						name: terminalName,
						pty: pty,
					});

					// Track this terminal
					snapshotTerminals.set(taskId, {
						terminal,
						writeEmitter,
						closeEmitter,
					});

					terminal.show();
				}

				outputChannel.appendLine(`[COMMAND] Terminal snapshot displayed: ${terminalName}`);
			}
		);
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to view terminal snapshot: ${error}`);
		vscode.window.showErrorMessage(`Failed to view terminal snapshot: ${error}`);
	}
}

/**
 * Refresh terminal snapshot (re-fetch and update existing terminal)
 */
async function refreshTerminalSnapshot(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(
			`\n[COMMAND] Refresh terminal snapshot for task ${taskId.substring(0, 8)}`
		);

		// Just call viewTerminalSnapshot - it already handles reusing terminals
		await viewTerminalSnapshot(taskId);

		vscode.window.showInformationMessage('Terminal snapshot refreshed');
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to refresh terminal snapshot: ${error}`);
		vscode.window.showErrorMessage(`Failed to refresh terminal snapshot: ${error}`);
	}
}

/**
 * Send text to terminal
 */
async function sendTextToTerminal(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(
			`\n[COMMAND] Send text to terminal for task ${taskId.substring(0, 8)}`
		);

		// Prompt user for command to send
		const text = await vscode.window.showInputBox({
			prompt: 'Enter command to send to the terminal (will be executed with Ctrl+C prefix)',
			placeHolder: 'e.g., ls -la',
		});

		if (!text) {
			outputChannel.appendLine('[COMMAND] User cancelled text input');
			return;
		}

		// Show progress
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Sending text to terminal...`,
				cancellable: false,
			},
			async (progress) => {
				progress.report({ message: 'Sending...' });
				// Send Ctrl+C, then the text, then carriage return
				const textToSend = `\x03${text}\r`;
				await vibeClient.sendTextToTerminal(taskId, textToSend);
				vscode.window.showInformationMessage(`Command sent to terminal: ${text}`);
				outputChannel.appendLine(`[COMMAND] Command sent successfully: ${text}`);
			}
		);
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to send text to terminal: ${error}`);
		vscode.window.showErrorMessage(`Failed to send text to terminal: ${error}`);
	}
}

/**
 * Show task details in an information message
 */
async function showTaskDetails(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(`\n[COMMAND] Show task details for ${taskId.substring(0, 8)}`);

		const task = await vibeClient.getTask(taskId);

		// Show task details with action options
		const action = await vscode.window.showInformationMessage(
			`Task: ${task.task_description}`,
			'Copy ID',
			'Copy Repository',
			'Open MR'
		);

		if (action === 'Copy ID') {
			await vscode.env.clipboard.writeText(task.id);
			vscode.window.showInformationMessage('Task ID copied to clipboard');
		} else if (action === 'Copy Repository') {
			await vscode.env.clipboard.writeText(task.repository);
			vscode.window.showInformationMessage('Repository URL copied to clipboard');
		} else if (action === 'Open MR' && task.mr_url) {
			await vscode.env.openExternal(vscode.Uri.parse(task.mr_url));
		}

		outputChannel.appendLine('[COMMAND] Task details displayed');
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to show task details: ${error}`);
		vscode.window.showErrorMessage(`Failed to show task details: ${error}`);
	}
}

/**
 * Switch tmux session in the active terminal
 */
async function switchTmuxSession(): Promise<void> {
	try {
		const activeTerminal = vscode.window.activeTerminal;
		if (!activeTerminal) {
			vscode.window.showWarningMessage('No active terminal found');
			return;
		}

		// Check if this terminal is connected to a VM
		const vmInfo = terminalVMMap.get(activeTerminal);
		if (!vmInfo) {
			vscode.window.showWarningMessage('This terminal is not connected to a Reindeer Coder VM');
			return;
		}

		outputChannel.appendLine(`[TMUX] Fetching tmux sessions for VM ${vmInfo.vmName}...`);

		// Execute tmux list-sessions on the VM
		const listCommand = [
			'gcloud',
			'compute',
			'ssh',
			vmInfo.vmName,
			`--project=${vmInfo.project}`,
			`--zone=${vmInfo.zone}`,
			'--tunnel-through-iap',
			'--quiet',
			'--command',
			'"sudo -u reindeer-vibe tmux list-sessions"',
		].join(' ');

		outputChannel.appendLine(`[TMUX] Executing: ${listCommand}`);

		// Execute the command
		const { execSync } = require('node:child_process');
		let output: string;
		try {
			output = execSync(listCommand, { encoding: 'utf-8', timeout: 30000 });
		} catch (error: any) {
			if (error.status === 1 && error.stdout) {
				// tmux list-sessions exits with 1 if no sessions found
				output = error.stdout;
			} else {
				throw error;
			}
		}

		outputChannel.appendLine(`[TMUX] Output: ${output}`);

		// Parse tmux sessions from output
		// Format: "session-name: N windows (created DATE) [WxH] (attached)"
		const lines = output
			.trim()
			.split('\n')
			.filter((line) => line.trim());
		if (lines.length === 0) {
			vscode.window.showInformationMessage('No tmux sessions found on this VM');
			return;
		}

		// Extract session names and create quick pick items
		interface SessionItem extends vscode.QuickPickItem {
			sessionName: string;
		}

		const sessions: SessionItem[] = lines.map((line) => {
			const sessionName = line.split(':')[0].trim();
			const isAttached = line.includes('(attached)');
			return {
				label: isAttached ? `$(check) ${sessionName}` : sessionName,
				description: isAttached ? '(current)' : '',
				detail: line,
				sessionName,
			};
		});

		// Show quick pick
		const selected = await vscode.window.showQuickPick(sessions, {
			placeHolder: 'Select a tmux session to switch to',
			title: 'Switch Tmux Session',
		});

		if (!selected) {
			return; // User cancelled
		}

		outputChannel.appendLine(`[TMUX] Switching to session: ${selected.sessionName}`);

		// Send switch command to terminal
		// Using Ctrl+C to cancel any running command, then switch-client, then Enter
		activeTerminal.sendText(`\x03tmux switch-client -t ${selected.sessionName}\r`, false);

		vscode.window.showInformationMessage(`Switched to tmux session: ${selected.sessionName}`);
	} catch (error) {
		outputChannel.appendLine(`[TMUX] Failed to switch session: ${error}`);
		vscode.window.showErrorMessage(`Failed to switch tmux session: ${error}`);
	}
}

export function deactivate() {
	console.log('Reindeer Coder extension is now deactivated');
}
