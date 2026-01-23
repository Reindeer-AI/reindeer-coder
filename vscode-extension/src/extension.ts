import * as vscode from 'vscode';
import {
	type ExtensionConfig,
	fetchExtensionConfig,
	type Task,
	VibeClient,
} from './api/vibe-client';
import { Auth0Client } from './auth/auth0-client';
import { SSHConfigManager } from './connection/ssh-config-manager';
import { SSHFSManager } from './connection/sshfs-manager';
import { TerminalManager } from './connection/terminal-manager';
import { TunnelManager } from './connection/tunnel-manager';
import { CreateTaskPanel } from './views/create-task-panel';
import { type TaskTreeItem, TaskTreeProvider } from './views/task-tree-provider';

let auth0Client: Auth0Client;
let vibeClient: VibeClient;
let taskTreeProvider: TaskTreeProvider;
let sshConfigManager: SSHConfigManager;
let sshfsManager: SSHFSManager;
let terminalManager: TerminalManager;
let tunnelManager: TunnelManager;
let outputChannel: vscode.OutputChannel;
let extensionConfig: ExtensionConfig;

// Track SSH terminal connections to VMs
interface TerminalVMInfo {
	vmName: string;
	zone: string;
	project: string;
	taskId: string;
	vmUser: string;
}
const terminalVMMap = new Map<vscode.Terminal, TerminalVMInfo>();

/**
 * Prompt user to enter server URL
 */
async function promptForServerUrl(
	config: vscode.WorkspaceConfiguration
): Promise<string | undefined> {
	const serverUrl = await vscode.window.showInputBox({
		prompt: 'Enter the Reindeer Coder server URL',
		placeHolder: 'https://your-server.example.com',
		validateInput: (value) => {
			if (!value) {
				return 'Server URL is required';
			}
			try {
				new URL(value);
				return null;
			} catch {
				return 'Please enter a valid URL';
			}
		},
	});

	if (serverUrl) {
		// Save to user settings
		await config.update('serverUrl', serverUrl, vscode.ConfigurationTarget.Global);
	}

	return serverUrl;
}

/**
 * Register the configure server command
 */
function registerConfigureCommand(
	context: vscode.ExtensionContext,
	config: vscode.WorkspaceConfiguration
) {
	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.configureServer', async () => {
			const serverUrl = await promptForServerUrl(config);
			if (serverUrl) {
				vscode.window
					.showInformationMessage(
						'Server URL configured. Please reload the window to apply changes.',
						'Reload'
					)
					.then((selection) => {
						if (selection === 'Reload') {
							vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					});
			}
		})
	);
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('Reindeer Coder extension is now active');

	// Create output channel
	outputChannel = vscode.window.createOutputChannel('Reindeer Coder');
	outputChannel.show(); // Show output channel on activation for debugging
	outputChannel.appendLine('='.repeat(80));
	outputChannel.appendLine('Reindeer Coder extension activated');
	outputChannel.appendLine(`Activation time: ${new Date().toISOString()}`);
	outputChannel.appendLine('='.repeat(80));

	// Get server URL from configuration
	const config = vscode.workspace.getConfiguration('reindeerCoder');
	const serverUrl = config.get<string>('serverUrl', '');

	// Initialize tree view early so it's available even without config
	outputChannel.appendLine('\n[UI] Initializing tree view...');
	taskTreeProvider = new TaskTreeProvider();
	const treeView = vscode.window.createTreeView('reindeerCoderTasks', {
		treeDataProvider: taskTreeProvider,
	});
	context.subscriptions.push(treeView);
	outputChannel.appendLine('[UI] Tree view initialized');

	// Register configure command early so it's always available
	registerConfigureCommand(context, config);

	// If no server URL configured, show the configure prompt
	if (!serverUrl) {
		outputChannel.appendLine('\n[CONFIG] No server URL configured, showing configure prompt...');
		taskTreeProvider.setConfigured(false);

		// Show a helpful message with a button to configure
		vscode.window
			.showInformationMessage(
				'Reindeer Coder: Server URL not configured. Configure it to get started.',
				'Configure Server'
			)
			.then((selection) => {
				if (selection === 'Configure Server') {
					vscode.commands.executeCommand('reindeerCoder.configureServer');
				}
			});
		return;
	}

	outputChannel.appendLine('\n[CONFIG] Loading configuration from server...');
	outputChannel.appendLine(`  Server URL: ${serverUrl}`);

	// Fetch configuration from server
	try {
		extensionConfig = await fetchExtensionConfig(serverUrl);
		outputChannel.appendLine('[CONFIG] Server configuration loaded successfully');
		outputChannel.appendLine(`  Auth0 Domain: ${extensionConfig.auth0.domain}`);
		outputChannel.appendLine(`  Auth0 Client ID: ${extensionConfig.auth0.clientId}`);
		outputChannel.appendLine(`  Auth0 Audience: ${extensionConfig.auth0.audience}`);
		outputChannel.appendLine(
			`  Auth0 Organization: ${extensionConfig.auth0.organizationId || '(none)'}`
		);
		outputChannel.appendLine(`  GCP Project: ${extensionConfig.gcp.project}`);
		outputChannel.appendLine(`  VM User: ${extensionConfig.vm.user}`);
	} catch (error) {
		const errorMsg = `Failed to fetch configuration from server: ${error}`;
		outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
		taskTreeProvider.setConfigured(false);
		vscode.window
			.showErrorMessage(`Reindeer Coder: ${errorMsg}`, 'Configure Server')
			.then((selection) => {
				if (selection === 'Configure Server') {
					vscode.commands.executeCommand('reindeerCoder.configureServer');
				}
			});
		return;
	}

	// Validate configuration
	if (!extensionConfig.auth0.clientId) {
		const errorMsg = 'Server did not return Auth0 configuration. Please check server settings.';
		outputChannel.appendLine(`\n[ERROR] ${errorMsg}`);
		vscode.window.showErrorMessage(`Reindeer Coder: ${errorMsg}`);
		return;
	}

	outputChannel.appendLine('\n[AUTH] Initializing Auth0 client...');

	// Initialize Auth0 client with server-provided configuration
	auth0Client = new Auth0Client(
		context,
		extensionConfig.auth0.domain,
		extensionConfig.auth0.clientId,
		extensionConfig.auth0.audience,
		extensionConfig.auth0.organizationId
	);

	outputChannel.appendLine('[AUTH] Auth0 client initialized');

	// Initialize API client
	outputChannel.appendLine('\n[API] Initializing API client...');
	outputChannel.appendLine(`  Server URL: ${serverUrl}`);
	vibeClient = new VibeClient(serverUrl, () => auth0Client.getAccessToken());

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
	sshConfigManager = new SSHConfigManager(outputChannel);
	sshfsManager = new SSHFSManager(outputChannel);
	terminalManager = new TerminalManager(outputChannel);
	tunnelManager = new TunnelManager(outputChannel);
	outputChannel.appendLine('[INIT] Managers initialized');

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

			outputChannel.appendLine(`\nServer Configuration:`);
			outputChannel.appendLine(`  Server URL: ${serverUrl}`);
			outputChannel.appendLine(`  Auth0 Domain: ${extensionConfig.auth0.domain}`);
			outputChannel.appendLine(`  Auth0 Client ID: ${extensionConfig.auth0.clientId}`);
			outputChannel.appendLine(`  Auth0 Audience: ${extensionConfig.auth0.audience}`);
			outputChannel.appendLine(
				`  Auth0 Organization: ${extensionConfig.auth0.organizationId || '(none)'}`
			);
			outputChannel.appendLine(`  GCP Project: ${extensionConfig.gcp.project}`);
			outputChannel.appendLine(`  VM User: ${extensionConfig.vm.user}`);

			outputChannel.appendLine('='.repeat(80));

			vscode.window.showInformationMessage('Debug info written to Reindeer Coder output channel');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.connectTask', async (item: TaskTreeItem) => {
			await connectToTask(item.task.id);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'reindeerCoder.connectTerminalOnly',
			async (item: TaskTreeItem) => {
				await connectTerminalOnly(item.task.id);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.disconnectTask', async (taskId: string) => {
			await disconnectFromTask(taskId);
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

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.createNewTask', async () => {
			outputChannel.appendLine('\n[COMMAND] Create new task command triggered');
			CreateTaskPanel.createOrShow(
				context.extensionUri,
				auth0Client,
				vibeClient,
				extensionConfig,
				async () => {
					outputChannel.appendLine('[COMMAND] Task created, refreshing task list');
					await loadTasks();
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'reindeerCoder.testFromLocalBrowser',
			async (item: TaskTreeItem) => {
				await testFromLocalBrowser(item.task.id);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.openTaskWebUI', async (taskId: string) => {
			await openTaskWebUI(taskId);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.completeTask', async (taskId: string) => {
			await completeTask(taskId);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('reindeerCoder.deleteTask', async (taskId: string) => {
			await deleteTask(taskId);
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
			tunnelManager.closeAllTunnels();
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
 * @deprecated No longer used with Remote-SSH approach
 */
async function _createWorkspaceConfig(
	workspacePath: string,
	options: {
		taskId: string;
		vmName: string;
		zone: string;
		project: string;
		tmuxSession: string;
		vmUser?: string;
	}
): Promise<void> {
	const fs = require('node:fs').promises;
	const path = require('node:path');
	const vmUser = options.vmUser || extensionConfig.vm.user;

	try {
		// Create .vscode directory
		const vscodeDir = path.join(workspacePath, '.vscode');
		await fs.mkdir(vscodeDir, { recursive: true });

		// Create tasks.json with SSH connection task
		const tasksConfig = {
			version: '2.0.0',
			tasks: [
				{
					label: 'Connect to Agent Session',
					type: 'shell',
					command: `gcloud compute ssh ${options.vmName} --project=${options.project} --zone=${options.zone} --tunnel-through-iap --ssh-flag="-t" -- sudo -u ${vmUser} tmux attach-session -t ${options.tmuxSession}`,
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
 * Connect to a task using VSCode Remote-SSH
 */
async function connectToTask(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(`Connecting to task ${taskId.substring(0, 8)}...`);

		// Get task details
		const taskDetails = await vibeClient.getTask(taskId);

		if (!taskDetails.vm_name || !taskDetails.vm_zone) {
			throw new Error('Task does not have VM information');
		}

		// Generate meaningful folder name for display
		const folderName = generateTaskFolderName(taskDetails);
		outputChannel.appendLine(`Task folder name: ${folderName}`);

		const gcpProject = extensionConfig.gcp.project;
		const defaultVmUser = extensionConfig.vm.user;

		// Show progress
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Connecting to ${folderName}`,
				cancellable: false,
			},
			async (progress) => {
				// Get VM user and workspace path from task metadata (or fallback to server defaults)
				const vmUser = taskDetails.metadata?.vm_user || defaultVmUser;
				const defaultWorkspacePath = `/home/${vmUser}/workspace`;
				const workspacePath =
					taskDetails.metadata?.workspace_path ||
					taskDetails.workspace_path ||
					defaultWorkspacePath;

				// Authorize user's SSH key for VM user
				progress.report({ message: 'Authorizing SSH key...' });
				await sshConfigManager.authorizeKeyForVmUser(
					taskDetails.vm_name!,
					taskDetails.vm_zone!,
					gcpProject,
					vmUser
				);

				// Create/update SSH config entry
				progress.report({ message: 'Updating SSH configuration...' });
				const hostName = await sshConfigManager.addOrUpdateHost({
					taskId,
					vmName: taskDetails.vm_name!,
					zone: taskDetails.vm_zone!,
					project: gcpProject,
					workspacePath,
					vmUser,
				});

				// Build Remote-SSH URI
				// Format: vscode-remote://ssh-remote+<host>/<path>
				const remotePath = workspacePath;
				const remoteUri = vscode.Uri.parse(`vscode-remote://ssh-remote+${hostName}${remotePath}`);

				// Check if Remote-SSH extension is installed
				// Try multiple possible extension IDs (MS VSCode, Cursor/Anysphere)
				const remoteSshExtension =
					vscode.extensions.getExtension('ms-vscode-remote.remote-ssh') ||
					vscode.extensions.getExtension('ms-vscode.remote-server') ||
					vscode.extensions.getExtension('anysphere.remote-ssh');

				if (!remoteSshExtension) {
					const install = await vscode.window.showErrorMessage(
						'The Remote-SSH extension is required to open workspaces. Please install it first.',
						'Install Remote-SSH'
					);
					if (install === 'Install Remote-SSH') {
						await vscode.commands.executeCommand(
							'workbench.extensions.installExtension',
							'ms-vscode-remote.remote-ssh'
						);
					}
					return;
				}

				// Open workspace in NEW window using Remote-SSH
				progress.report({ message: 'Opening remote workspace...' });
				outputChannel.appendLine(`[SSH] Opening remote URI: ${remoteUri.toString()}`);

				await vscode.commands.executeCommand('vscode.openFolder', remoteUri, {
					forceNewWindow: true,
				});

				vscode.window.showInformationMessage(
					`Connected to ${folderName} via Remote-SSH. The workspace will open in a new window.`
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
async function connectTerminalOnly(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(`Opening terminal for task ${taskId.substring(0, 8)}...`);

		// Get task details
		const taskDetails = await vibeClient.getTask(taskId);

		if (!taskDetails.vm_name || !taskDetails.vm_zone) {
			throw new Error('Task does not have VM information');
		}

		const gcpProject = extensionConfig.gcp.project;
		const defaultVmUser = extensionConfig.vm.user;

		// Use the same tmux session naming convention as the backend
		const shortId = taskId.substring(0, 8);
		const tmuxSession = `vibe-${shortId}`;

		// Get VM user from task metadata (or fallback to server default)
		const vmUser = taskDetails.metadata?.vm_user || defaultVmUser;

		// Build SSH command with correct flags and sudo to VM user
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
			`sudo -u ${vmUser}`,
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
			location: vscode.TerminalLocation.Editor,
		});

		// Track terminal -> VM mapping for tmux session switching
		terminalVMMap.set(terminal, {
			vmName: taskDetails.vm_name,
			zone: taskDetails.vm_zone!,
			project: gcpProject,
			taskId,
			vmUser,
		});

		terminal.show();
		outputChannel.appendLine(`Opened terminal for task ${shortId} in editor area`);

		vscode.window.showInformationMessage(`Connected terminal to task ${shortId}`);
	} catch (error) {
		outputChannel.appendLine(`Failed to connect terminal: ${error}`);
		vscode.window.showErrorMessage(`Failed to connect terminal: ${error}`);
	}
}

/**
 * Disconnect from a task (remove SSH config entry and close terminal)
 */
async function disconnectFromTask(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(`Disconnecting from task ${taskId}...`);

		// Remove SSH config entry
		await sshConfigManager.removeHost(taskId);

		// Disconnect terminal
		terminalManager.disconnect(taskId);

		vscode.window.showInformationMessage(`Disconnected from task ${taskId}`);
	} catch (error) {
		outputChannel.appendLine(`Failed to disconnect from task: ${error}`);
		vscode.window.showErrorMessage(`Failed to disconnect from task: ${error}`);
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
 * Test from local browser - creates tunnel and opens VSCode simple browser
 */
async function testFromLocalBrowser(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(
			`\n[COMMAND] Test from local browser for task ${taskId.substring(0, 8)}`
		);

		// Get task details
		const taskDetails = await vibeClient.getTask(taskId);

		if (!taskDetails.vm_name || !taskDetails.vm_zone) {
			throw new Error('Task does not have VM information');
		}

		const gcpProject = extensionConfig.gcp.project;

		// Create tunnel using TunnelManager (handles port conflicts automatically)
		await tunnelManager.createTunnel({
			vmName: taskDetails.vm_name,
			zone: taskDetails.vm_zone,
			project: gcpProject,
			localPort: 3715,
			remotePort: 5173,
			taskId,
		});

		// Wait a moment for tunnel to establish
		await new Promise((resolve) => setTimeout(resolve, 2000));

		// Open VSCode simple browser
		await vscode.commands.executeCommand('simpleBrowser.show', 'http://localhost:3715');

		outputChannel.appendLine(`[COMMAND] Tunnel created and browser opened`);
		vscode.window.showInformationMessage(
			'Tunnel created and browser opened. Keep the tunnel terminal running.'
		);
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to test from local browser: ${error}`);
		vscode.window.showErrorMessage(`Failed to test from local browser: ${error}`);
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
			`"sudo -u ${vmInfo.vmUser} tmux list-sessions"`,
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

/**
 * Open task in web UI
 */
async function openTaskWebUI(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(`\n[COMMAND] Opening task ${taskId.substring(0, 8)} in web UI`);

		const webUrl = `${extensionConfig.app.url}/tasks/${taskId}`;
		await vscode.env.openExternal(vscode.Uri.parse(webUrl));

		vscode.window.showInformationMessage(`Opened task in web browser`);
		outputChannel.appendLine(`[COMMAND] Opened ${webUrl}`);
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to open task in web UI: ${error}`);
		vscode.window.showErrorMessage(`Failed to open task in web UI: ${error}`);
	}
}

/**
 * Complete a task
 */
async function completeTask(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(`\n[COMMAND] Complete task ${taskId.substring(0, 8)}`);

		// Show confirmation dialog
		const confirmation = await vscode.window.showWarningMessage(
			'Are you sure you want to mark this task as completed?',
			{ modal: true },
			'Yes, Complete'
		);

		if (confirmation !== 'Yes, Complete') {
			outputChannel.appendLine('[COMMAND] User cancelled task completion');
			return;
		}

		// Show progress
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Completing task...',
				cancellable: false,
			},
			async (progress) => {
				progress.report({ message: 'Updating task status...' });
				await vibeClient.completeTask(taskId);

				progress.report({ message: 'Refreshing task list...' });
				await loadTasks();

				vscode.window.showInformationMessage('Task completed successfully');
				outputChannel.appendLine(`[COMMAND] Task ${taskId.substring(0, 8)} completed`);
			}
		);
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to complete task: ${error}`);
		vscode.window.showErrorMessage(`Failed to complete task: ${error}`);
	}
}

/**
 * Delete a task
 */
async function deleteTask(taskId: string): Promise<void> {
	try {
		outputChannel.appendLine(`\n[COMMAND] Delete task ${taskId.substring(0, 8)}`);

		// Show confirmation dialog with stronger warning
		const confirmation = await vscode.window.showWarningMessage(
			'Are you sure you want to delete this task? This action cannot be undone.',
			{ modal: true },
			'Yes, Delete'
		);

		if (confirmation !== 'Yes, Delete') {
			outputChannel.appendLine('[COMMAND] User cancelled task deletion');
			return;
		}

		// Show progress
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Deleting task...',
				cancellable: false,
			},
			async (progress) => {
				progress.report({ message: 'Removing task...' });
				await vibeClient.deleteTask(taskId);

				progress.report({ message: 'Refreshing task list...' });
				await loadTasks();

				vscode.window.showInformationMessage('Task deleted successfully');
				outputChannel.appendLine(`[COMMAND] Task ${taskId.substring(0, 8)} deleted`);
			}
		);
	} catch (error) {
		outputChannel.appendLine(`[ERROR] Failed to delete task: ${error}`);
		vscode.window.showErrorMessage(`Failed to delete task: ${error}`);
	}
}

export function deactivate() {
	console.log('Reindeer Coder extension is now deactivated');
}
