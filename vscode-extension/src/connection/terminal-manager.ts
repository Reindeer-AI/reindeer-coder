import * as vscode from 'vscode';

export interface TerminalOptions {
	vmName: string;
	zone: string;
	project: string;
	tmuxSession: string;
	taskId: string;
	vmUser?: string;
}

export class TerminalManager {
	private terminals: Map<string, vscode.Terminal> = new Map();

	constructor(private readonly outputChannel: vscode.OutputChannel) {}

	/**
	 * Connect to a remote tmux session via gcloud compute ssh
	 */
	async connect(options: TerminalOptions): Promise<vscode.Terminal> {
		const { taskId, vmName, zone, project, tmuxSession, vmUser } = options;
		const user = vmUser || 'agent'; // Fallback to generic default if not provided

		// Check if terminal already exists
		const existingTerminal = this.terminals.get(taskId);
		if (existingTerminal) {
			existingTerminal.show();
			return existingTerminal;
		}

		// Build SSH command with tmux attach
		const sshCommand = this.buildSSHCommand(vmName, zone, project, tmuxSession, user);

		// Create terminal
		const terminal = vscode.window.createTerminal({
			name: `Coder: ${taskId}`,
			shellPath: '/bin/bash',
			shellArgs: ['-c', sshCommand],
		});

		// Track terminal
		this.terminals.set(taskId, terminal);

		// Handle terminal close
		vscode.window.onDidCloseTerminal((closedTerminal) => {
			if (closedTerminal === terminal) {
				this.terminals.delete(taskId);
				this.outputChannel.appendLine(`Terminal closed for task ${taskId}`);
			}
		});

		terminal.show();
		this.outputChannel.appendLine(`Connected to tmux session ${tmuxSession} for task ${taskId}`);

		return terminal;
	}

	/**
	 * Disconnect from a terminal (close it)
	 */
	disconnect(taskId: string): void {
		const terminal = this.terminals.get(taskId);
		if (terminal) {
			terminal.dispose();
			this.terminals.delete(taskId);
			this.outputChannel.appendLine(`Disconnected terminal for task ${taskId}`);
		}
	}

	/**
	 * Disconnect all terminals
	 */
	disconnectAll(): void {
		for (const terminal of this.terminals.values()) {
			terminal.dispose();
		}
		this.terminals.clear();
	}

	/**
	 * Get terminal for a task
	 */
	getTerminal(taskId: string): vscode.Terminal | undefined {
		return this.terminals.get(taskId);
	}

	/**
	 * Build SSH command with tmux attach
	 */
	private buildSSHCommand(
		vmName: string,
		zone: string,
		project: string,
		tmuxSession: string,
		vmUser: string
	): string {
		// Command to SSH and attach to tmux session as the VM user
		const sshCmd = [
			'gcloud',
			'compute',
			'ssh',
			vmName,
			`--project=${project}`,
			`--zone=${zone}`,
			'--tunnel-through-iap',
			'--ssh-flag="-t"',
			'--',
			`sudo -u ${vmUser}`,
			`tmux attach-session -t ${tmuxSession}`,
		].join(' ');

		return sshCmd;
	}

	/**
	 * Check if terminal is active for a task
	 */
	isConnected(taskId: string): boolean {
		return this.terminals.has(taskId);
	}
}
