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

export async function activate(context: vscode.ExtensionContext) {
	console.log('Vibe Coding extension is now active');

	// Create output channel
	outputChannel = vscode.window.createOutputChannel('Vibe Coding');
	outputChannel.show(); // Show output channel on activation for debugging
	outputChannel.appendLine('='.repeat(80));
	outputChannel.appendLine('Vibe Coding extension activated');
	outputChannel.appendLine(`Activation time: ${new Date().toISOString()}`);
	outputChannel.appendLine('='.repeat(80));

	// Get configuration
	const config = vscode.workspace.getConfiguration('vibeCoding');
	const apiUrl = config.get<string>('apiUrl', 'https://vibe.reindeerlabs.ai');
	const auth0Domain = config.get<string>('auth0Domain', 'dev-0d0uyl2iqc17144b.us.auth0.com');
	const auth0ClientId = config.get<string>('auth0ClientId', 'i6QxH7zvtkkm5pD1iCS4mcIavVXhuOiZ');
	const auth0Audience = config.get<string>('auth0Audience', 'https://vibe.reindeerlabs.ai');
	const auth0OrganizationId = config.get<string>('auth0OrganizationId', 'org_9WU9bq88J0jAPjmM');
	const gcpProject = config.get<string>('gcpProject', 'reindeer-vibe');
	const mountPath = config.get<string>('mountPath', '~/vibe-mounts');

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
			'Auth0 Client ID is not configured. Please set vibeCoding.auth0ClientId in settings.';
		outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
		vscode.window.showErrorMessage(`Vibe Coding: ${errorMsg}`);
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

	// Initialize Vibe API client
	outputChannel.appendLine('\n[API] Initializing Vibe API client...');
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

	outputChannel.appendLine('[API] Vibe API client initialized');

	// Initialize managers
	outputChannel.appendLine('\n[INIT] Initializing managers...');
	sshfsManager = new SSHFSManager(outputChannel);
	terminalManager = new TerminalManager(outputChannel);
	outputChannel.appendLine('[INIT] Managers initialized');

	// Initialize tree view
	outputChannel.appendLine('\n[UI] Initializing tree view...');
	taskTreeProvider = new TaskTreeProvider();
	const treeView = vscode.window.createTreeView('vibeCodingTasks', {
		treeDataProvider: taskTreeProvider,
	});
	context.subscriptions.push(treeView);
	outputChannel.appendLine('[UI] Tree view initialized');

	// Check authentication status and load tasks
	outputChannel.appendLine('\n[AUTH] Checking authentication status...');
	await checkAuthAndLoadTasks();

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('vibeCoding.login', async () => {
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
		vscode.commands.registerCommand('vibeCoding.logout', async () => {
			outputChannel.appendLine('\n[COMMAND] Logout command triggered');
			await auth0Client.logout();
			taskTreeProvider.setAuthenticated(false);
			taskTreeProvider.setTasks([]);
			outputChannel.appendLine('[AUTH] Logged out successfully');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vibeCoding.refreshTasks', async () => {
			outputChannel.appendLine('\n[COMMAND] Refresh tasks command triggered');
			await loadTasks();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vibeCoding.showDebugInfo', async () => {
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
			const config = vscode.workspace.getConfiguration('vibeCoding');
			outputChannel.appendLine(`  API URL: ${config.get('apiUrl')}`);
			outputChannel.appendLine(`  Auth0 Domain: ${config.get('auth0Domain')}`);
			outputChannel.appendLine(`  Auth0 Client ID: ${config.get('auth0ClientId')}`);
			outputChannel.appendLine(`  Auth0 Audience: ${config.get('auth0Audience')}`);
			outputChannel.appendLine(`  Auth0 Organization: ${config.get('auth0OrganizationId')}`);
			outputChannel.appendLine(`  GCP Project: ${config.get('gcpProject')}`);

			outputChannel.appendLine('='.repeat(80));

			vscode.window.showInformationMessage('Debug info written to Vibe Coding output channel');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vibeCoding.connectTask', async (item: TaskTreeItem) => {
			await connectToTask(item.task.id, gcpProject, mountPath);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'vibeCoding.connectTerminalOnly',
			async (item: TaskTreeItem) => {
				await connectTerminalOnly(item.task.id, gcpProject);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vibeCoding.disconnectTask', async (taskId: string) => {
			await disconnectFromTask(taskId);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vibeCoding.viewTerminalSnapshot', async (taskId: string) => {
			await viewTerminalSnapshot(taskId);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'vibeCoding.refreshTerminalSnapshot',
			async (taskId: string) => {
				await refreshTerminalSnapshot(taskId);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('vibeCoding.sendTextToTerminal', async (taskId: string) => {
			await sendTextToTerminal(taskId);
		})
	);

	// Note: Tree item clicks now handled by inline buttons instead of selection event

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
					label: 'Connect to Vibe Session',
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
					tmuxSession: taskDetails.tmux_session || `vibe-${taskId.substring(0, 8)}`,
				});

				// Open workspace in NEW window
				progress.report({ message: 'Opening workspace...' });
				const uri = vscode.Uri.file(mountedPath);
				await vscode.commands.executeCommand('vscode.openFolder', uri, {
					forceNewWindow: true,
				});

				vscode.window.showInformationMessage(
					`Connected to ${folderName}. Use Terminal > Run Task > "Connect to Vibe Session" to open the remote terminal.`
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
		const tmuxSession = taskDetails.tmux_session || `vibe-${shortId}`;

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

		// Create terminal in current window
		const terminal = vscode.window.createTerminal({
			name: `Vibe: ${shortId}`,
			shellPath: '/bin/bash',
			shellArgs: ['-c', sshCommand],
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
 * Process raw terminal buffer through xterm to get final rendered state
 */
function processTerminalBuffer(rawBuffer: string): string {
	try {
		const { Terminal } = require('@xterm/headless');

		outputChannel.appendLine(`[PROCESS] Raw buffer length: ${rawBuffer.length} chars`);

		// Create a headless terminal with reasonable dimensions
		const terminal = new Terminal({
			cols: 200,
			rows: 10000,
			allowProposedApi: true,
		});

		// Write the raw buffer (this interprets all ANSI sequences)
		terminal.write(rawBuffer);

		// Extract the final rendered text line by line
		const lines: string[] = [];
		const buffer = terminal.buffer.active;

		for (let i = 0; i < buffer.length; i++) {
			const line = buffer.getLine(i);
			if (line) {
				const text = line.translateToString(true); // true = trim whitespace
				// Only include non-empty lines or preserve structure
				if (text.trim() || i < buffer.length - 1) {
					lines.push(text);
				}
			}
		}

		terminal.dispose();

		const result = lines.join('\n');
		outputChannel.appendLine(`[PROCESS] Processed buffer length: ${result.length} chars`);
		outputChannel.appendLine(`[PROCESS] Lines extracted: ${lines.length}`);

		return result;
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to process terminal buffer: ${error}`);
		// Fall back to raw buffer if processing fails
		return rawBuffer;
	}
}

/**
 * View terminal snapshot for a task
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

				// Process the buffer to get final rendered state
				progress.report({ message: 'Processing terminal output...' });
				const processedBuffer = processTerminalBuffer(terminalBuffer);

				// Save to temporary file and open in editor
				progress.report({ message: 'Opening snapshot...' });
				const fs = require('node:fs').promises;
				const path = require('node:path');
				const os = require('node:os');

				const tmpDir = os.tmpdir();
				const tmpFile = path.join(tmpDir, `vibe-terminal-${taskId.substring(0, 8)}.txt`);

				await fs.writeFile(tmpFile, processedBuffer, 'utf-8');

				const doc = await vscode.workspace.openTextDocument(tmpFile);
				await vscode.window.showTextDocument(doc, { preview: false });

				outputChannel.appendLine(`[COMMAND] Terminal snapshot opened: ${tmpFile}`);
			}
		);
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to view terminal snapshot: ${error}`);
		vscode.window.showErrorMessage(`Failed to view terminal snapshot: ${error}`);
	}
}

/**
 * Refresh terminal snapshot (re-fetch and update the file)
 */
async function refreshTerminalSnapshot(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(
			`\n[COMMAND] Refresh terminal snapshot for task ${taskId.substring(0, 8)}`
		);

		// Show progress
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Refreshing terminal snapshot...`,
				cancellable: false,
			},
			async (progress) => {
				// Fetch terminal snapshot
				progress.report({ message: 'Fetching latest terminal data...' });
				const terminalBuffer = await vibeClient.getTerminalSnapshot(taskId);

				if (!terminalBuffer) {
					vscode.window.showWarningMessage('No terminal snapshot available for this task');
					return;
				}

				// Process the buffer to get final rendered state
				progress.report({ message: 'Processing terminal output...' });
				const processedBuffer = processTerminalBuffer(terminalBuffer);

				// Update the temporary file
				progress.report({ message: 'Updating snapshot...' });
				const fs = require('node:fs').promises;
				const path = require('node:path');
				const os = require('node:os');

				const tmpDir = os.tmpdir();
				const tmpFile = path.join(tmpDir, `vibe-terminal-${taskId.substring(0, 8)}.txt`);

				await fs.writeFile(tmpFile, processedBuffer, 'utf-8');

				// Check if the file is already open
				const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === tmpFile);
				if (openDoc) {
					// Reopen to refresh
					await vscode.window.showTextDocument(openDoc, { preview: false });
					vscode.window.showInformationMessage('Terminal snapshot refreshed');
				} else {
					// Open the file if not already open
					const doc = await vscode.workspace.openTextDocument(tmpFile);
					await vscode.window.showTextDocument(doc, { preview: false });
				}

				outputChannel.appendLine(`[COMMAND] Terminal snapshot refreshed: ${tmpFile}`);
			}
		);
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

		// Prompt user for text to send
		const text = await vscode.window.showInputBox({
			prompt: 'Enter text to send to the terminal',
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
				await vibeClient.sendTextToTerminal(taskId, text);
				vscode.window.showInformationMessage(`Text sent to terminal: ${text}`);
				outputChannel.appendLine(`[COMMAND] Text sent successfully: ${text}`);
			}
		);
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to send text to terminal: ${error}`);
		vscode.window.showErrorMessage(`Failed to send text to terminal: ${error}`);
	}
}

export function deactivate() {
	console.log('Vibe Coding extension is now deactivated');
}
