import { exec } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execAsync = promisify(exec);

export interface TunnelOptions {
	vmName: string;
	zone: string;
	project: string;
	localPort: number;
	remotePort: number;
	taskId: string;
}

export interface PortStatus {
	inUse: boolean;
	pid?: number;
	processName?: string;
}

export class TunnelManager {
	private activeTunnels: Map<number, vscode.Terminal> = new Map();

	constructor(private readonly outputChannel: vscode.OutputChannel) {}

	/**
	 * Check if a port is in use and get information about the process using it
	 */
	async checkPortAvailability(port: number): Promise<PortStatus> {
		try {
			const platform = os.platform();

			if (platform === 'darwin' || platform === 'linux') {
				// Use lsof on macOS and Linux
				try {
					const { stdout } = await execAsync(`lsof -ti:${port}`);
					const pid = parseInt(stdout.trim(), 10);

					if (pid) {
						// Try to get process name
						try {
							const { stdout: psOutput } = await execAsync(`ps -p ${pid} -o comm=`);
							const processName = psOutput.trim();
							return { inUse: true, pid, processName };
						} catch {
							return { inUse: true, pid };
						}
					}
				} catch (_error) {
					// lsof returns non-zero exit code if port is not in use
					return { inUse: false };
				}
			} else if (platform === 'win32') {
				// Use netstat on Windows
				try {
					const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
					const lines = stdout.trim().split('\n');

					for (const line of lines) {
						if (line.includes('LISTENING') || line.includes('ESTABLISHED')) {
							const parts = line.trim().split(/\s+/);
							const pid = parseInt(parts[parts.length - 1], 10);
							if (pid) {
								// Try to get process name
								try {
									const { stdout: tasklistOutput } = await execAsync(
										`tasklist /FI "PID eq ${pid}" /FO CSV /NH`
									);
									const processName = tasklistOutput.split(',')[0].replace(/"/g, '');
									return { inUse: true, pid, processName };
								} catch {
									return { inUse: true, pid };
								}
							}
						}
					}
					return { inUse: false };
				} catch {
					// netstat failed or port not in use
					return { inUse: false };
				}
			} else {
				// Unknown platform - assume port is available
				this.outputChannel.appendLine(
					`[TUNNEL] Unknown platform ${platform}, cannot check port availability`
				);
				return { inUse: false };
			}

			return { inUse: false };
		} catch (error) {
			// If we can't check, assume port is available
			this.outputChannel.appendLine(`[TUNNEL] Error checking port availability: ${error}`);
			return { inUse: false };
		}
	}

	/**
	 * Kill a process using a specific port
	 */
	async killProcessOnPort(port: number): Promise<void> {
		const portStatus = await this.checkPortAvailability(port);

		if (!portStatus.inUse || !portStatus.pid) {
			this.outputChannel.appendLine(`[TUNNEL] Port ${port} is not in use`);
			return;
		}

		try {
			const platform = os.platform();

			if (platform === 'darwin' || platform === 'linux') {
				await execAsync(`kill -9 ${portStatus.pid}`);
			} else if (platform === 'win32') {
				await execAsync(`taskkill /F /PID ${portStatus.pid}`);
			}

			this.outputChannel.appendLine(`[TUNNEL] Killed process ${portStatus.pid} on port ${port}`);

			// Wait a moment for the port to be freed
			await new Promise((resolve) => setTimeout(resolve, 500));
		} catch (error: any) {
			if (error.message?.includes('EPERM') || error.message?.includes('Access is denied')) {
				throw new Error(
					`Permission denied when trying to kill process ${portStatus.pid}. ` +
						`Please run VSCode with elevated privileges (sudo/administrator) or manually close the process.`
				);
			}
			throw new Error(`Failed to kill process ${portStatus.pid}: ${error}`);
		}
	}

	/**
	 * Ensure a port is available, prompting user to kill blocking process if needed
	 */
	async ensurePortAvailable(port: number): Promise<void> {
		const portStatus = await this.checkPortAvailability(port);

		if (!portStatus.inUse) {
			this.outputChannel.appendLine(`[TUNNEL] Port ${port} is available`);
			return;
		}

		const processInfo = portStatus.processName
			? `${portStatus.processName} (PID ${portStatus.pid})`
			: `PID ${portStatus.pid}`;

		const action = await vscode.window.showWarningMessage(
			`Port ${port} is in use by ${processInfo}. Do you want to close it?`,
			'Kill Process',
			'Cancel'
		);

		if (action === 'Kill Process') {
			try {
				await this.killProcessOnPort(port);
				this.outputChannel.appendLine(`[TUNNEL] Successfully freed port ${port}`);
			} catch (error) {
				this.outputChannel.appendLine(`[TUNNEL] Failed to free port ${port}: ${error}`);
				throw error;
			}
		} else {
			throw new Error(`Port ${port} is in use. Cannot create tunnel.`);
		}
	}

	/**
	 * Create a tunnel to a VM
	 */
	async createTunnel(options: TunnelOptions): Promise<vscode.Terminal> {
		const { vmName, zone, project, localPort, remotePort } = options;

		// Check if we already have a tunnel on this port
		const existingTunnel = this.activeTunnels.get(localPort);
		if (existingTunnel) {
			this.outputChannel.appendLine(
				`[TUNNEL] Tunnel already exists on port ${localPort}, reusing it`
			);
			existingTunnel.show();
			return existingTunnel;
		}

		// Ensure port is available
		await this.ensurePortAvailable(localPort);

		// Build tunnel command
		const tunnelCommand = [
			'gcloud',
			'compute',
			'ssh',
			vmName,
			`--project=${project}`,
			`--zone=${zone}`,
			'--tunnel-through-iap',
			'--',
			`-N -L ${localPort}:127.0.0.1:${remotePort}`,
		].join(' ');

		this.outputChannel.appendLine(`[TUNNEL] Creating tunnel: ${tunnelCommand}`);

		// Create terminal
		const terminal = vscode.window.createTerminal({
			name: `Tunnel - ${vmName}`,
			shellPath: '/bin/bash',
			shellArgs: ['-c', tunnelCommand],
			location: vscode.TerminalLocation.Panel,
		});

		// Track tunnel
		this.activeTunnels.set(localPort, terminal);

		// Handle terminal close
		vscode.window.onDidCloseTerminal((closedTerminal) => {
			if (closedTerminal === terminal) {
				this.activeTunnels.delete(localPort);
				this.outputChannel.appendLine(`[TUNNEL] Tunnel closed for port ${localPort}`);
			}
		});

		terminal.show();
		this.outputChannel.appendLine(
			`[TUNNEL] Created tunnel from localhost:${localPort} to ${vmName}:${remotePort}`
		);

		return terminal;
	}

	/**
	 * Close a tunnel on a specific port
	 */
	closeTunnel(port: number): void {
		const tunnel = this.activeTunnels.get(port);
		if (tunnel) {
			tunnel.dispose();
			this.activeTunnels.delete(port);
			this.outputChannel.appendLine(`[TUNNEL] Closed tunnel on port ${port}`);
		}
	}

	/**
	 * Close all active tunnels
	 */
	closeAllTunnels(): void {
		for (const tunnel of this.activeTunnels.values()) {
			tunnel.dispose();
		}
		this.activeTunnels.clear();
		this.outputChannel.appendLine(`[TUNNEL] Closed all tunnels`);
	}

	/**
	 * Get the terminal for a tunnel on a specific port
	 */
	getTunnel(port: number): vscode.Terminal | undefined {
		return this.activeTunnels.get(port);
	}
}
