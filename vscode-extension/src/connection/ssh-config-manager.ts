import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as vscode from 'vscode';

export interface SSHHostConfig {
	taskId: string;
	vmName: string;
	zone: string;
	project: string;
	workspacePath: string;
	vmUser: string;
}

export class SSHConfigManager {
	private readonly sshConfigPath: string;

	constructor(private readonly outputChannel: vscode.OutputChannel) {
		this.sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
	}

	/**
	 * Copy local gcloud SSH public key to VM user's authorized_keys
	 * This allows direct SSH access as the specified user
	 */
	async authorizeKeyForVmUser(
		vmName: string,
		zone: string,
		project: string,
		vmUser: string
	): Promise<void> {
		const { spawn } = require('node:child_process');

		this.outputChannel.appendLine(
			`\n[SSH-CONFIG] Authorizing SSH key for ${vmUser} user on ${vmName}`
		);

		// Read the local public key
		const publicKeyPath = path.join(os.homedir(), '.ssh', 'google_compute_engine.pub');
		let publicKey: string;
		try {
			publicKey = await fs.readFile(publicKeyPath, 'utf-8');
			publicKey = publicKey.trim();
			this.outputChannel.appendLine(`[SSH-CONFIG] Read local public key from ${publicKeyPath}`);
		} catch (error: any) {
			const errorMsg = `Failed to read local public key at ${publicKeyPath}: ${error.message}`;
			this.outputChannel.appendLine(`[SSH-CONFIG ERROR] ${errorMsg}`);
			throw new Error(errorMsg);
		}

		// Command to append the local user's public key to the VM user's authorized_keys
		// This allows multiple users to connect with their own SSH keys
		// We escape the public key properly for bash
		const escapedKey = publicKey.replace(/'/g, "'\\''");
		const copyKeyCommand = `
			sudo mkdir -p /home/${vmUser}/.ssh && \
			echo '${escapedKey}' | sudo tee -a /home/${vmUser}/.ssh/authorized_keys > /dev/null && \
			sudo chown -R ${vmUser}:${vmUser} /home/${vmUser}/.ssh && \
			sudo chmod 700 /home/${vmUser}/.ssh && \
			sudo chmod 600 /home/${vmUser}/.ssh/authorized_keys && \
			echo "SSH key appended to ${vmUser} authorized_keys"
		`;

		return new Promise((resolve, reject) => {
			const gcloudArgs = [
				'compute',
				'ssh',
				vmName,
				`--project=${project}`,
				`--zone=${zone}`,
				'--tunnel-through-iap',
				'--command',
				copyKeyCommand,
			];

			this.outputChannel.appendLine(`[SSH-CONFIG] Running: gcloud ${gcloudArgs.join(' ')}`);

			const proc = spawn('gcloud', gcloudArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
			let stdout = '';
			let stderr = '';

			proc.stdout?.on('data', (data: Buffer) => {
				stdout += data.toString();
			});

			proc.stderr?.on('data', (data: Buffer) => {
				stderr += data.toString();
			});

			proc.on('error', (err) => {
				this.outputChannel.appendLine(`[SSH-CONFIG ERROR] Failed to authorize key: ${err.message}`);
				reject(err);
			});

			proc.on('close', (code) => {
				if (code === 0) {
					this.outputChannel.appendLine(`[SSH-CONFIG] ✓ SSH key authorized successfully`);
					this.outputChannel.appendLine(`[SSH-CONFIG] Output: ${stdout.trim()}`);
					resolve();
				} else {
					const error = `Failed to authorize SSH key (exit code ${code}): ${stderr}`;
					this.outputChannel.appendLine(`[SSH-CONFIG ERROR] ${error}`);
					reject(new Error(error));
				}
			});
		});
	}

	/**
	 * Add or update SSH config entry for a task
	 */
	async addOrUpdateHost(config: SSHHostConfig): Promise<string> {
		try {
			const hostName = `reindeer-${config.taskId.substring(0, 8)}`;
			this.outputChannel.appendLine(`\n[SSH-CONFIG] Adding/updating host: ${hostName}`);
			this.outputChannel.appendLine(`[SSH-CONFIG] VM: ${config.vmName}`);
			this.outputChannel.appendLine(`[SSH-CONFIG] Zone: ${config.zone}`);
			this.outputChannel.appendLine(`[SSH-CONFIG] Project: ${config.project}`);

			// Ensure .ssh directory exists
			const sshDir = path.dirname(this.sshConfigPath);
			await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });

			// Read existing config or create empty string
			let configContent = '';
			try {
				configContent = await fs.readFile(this.sshConfigPath, 'utf-8');
			} catch (error: any) {
				if (error.code !== 'ENOENT') {
					throw error;
				}
				this.outputChannel.appendLine(
					'[SSH-CONFIG] SSH config file does not exist, creating new one'
				);
			}

			// Remove existing entry for this host if it exists
			const hostMarker = `# Reindeer Coder - ${hostName}`;
			const lines = configContent.split('\n');
			const filteredLines: string[] = [];
			let skipUntilNextHost = false;

			for (const line of lines) {
				if (line.trim().startsWith(`# Reindeer Coder - `)) {
					// Check if this is our host marker
					if (line.trim() === hostMarker) {
						skipUntilNextHost = true;
						continue;
					} else {
						// Different Reindeer host, stop skipping
						skipUntilNextHost = false;
					}
				} else if (skipUntilNextHost && line.trim().startsWith('Host ')) {
					// We've reached a different Host entry, stop skipping
					skipUntilNextHost = false;
				}

				if (!skipUntilNextHost) {
					filteredLines.push(line);
				}
			}

			// Build new host entry
			// Connect directly as VM user using SSH key authentication
			// The authorizeKeyForVmUser() method copies the gcloud SSH key to the VM user's authorized_keys
			const identityFile = path.join(os.homedir(), '.ssh', 'google_compute_engine');
			const newHostEntry = [
				'',
				hostMarker,
				`Host ${hostName}`,
				`    HostName ${config.vmName}`,
				`    User ${config.vmUser}`,
				`    ProxyCommand gcloud compute start-iap-tunnel ${config.vmName} %p --listen-on-stdin --project=${config.project} --zone=${config.zone}`,
				`    StrictHostKeyChecking no`,
				`    UserKnownHostsFile /dev/null`,
				`    IdentityFile ${identityFile}`,
				`    ServerAliveInterval 30`,
				`    ServerAliveCountMax 3`,
				'',
			].join('\n');

			// Append new entry
			const updatedConfig = filteredLines.join('\n').trimEnd() + newHostEntry;

			// Write updated config
			await fs.writeFile(this.sshConfigPath, updatedConfig, { mode: 0o600 });

			this.outputChannel.appendLine(`[SSH-CONFIG] ✓ Successfully added/updated host: ${hostName}`);
			this.outputChannel.appendLine(`[SSH-CONFIG] SSH config path: ${this.sshConfigPath}`);

			return hostName;
		} catch (error) {
			this.outputChannel.appendLine(`\n[SSH-CONFIG ERROR] Failed to update SSH config:`);
			this.outputChannel.appendLine(`  Error: ${error}`);
			throw new Error(`Failed to update SSH config: ${error}`);
		}
	}

	/**
	 * Remove SSH config entry for a task
	 */
	async removeHost(taskId: string): Promise<void> {
		try {
			const hostName = `reindeer-${taskId.substring(0, 8)}`;
			this.outputChannel.appendLine(`\n[SSH-CONFIG] Removing host: ${hostName}`);

			// Read existing config
			let configContent = '';
			try {
				configContent = await fs.readFile(this.sshConfigPath, 'utf-8');
			} catch (error: any) {
				if (error.code === 'ENOENT') {
					this.outputChannel.appendLine(
						'[SSH-CONFIG] SSH config file does not exist, nothing to remove'
					);
					return;
				}
				throw error;
			}

			// Remove entry for this host
			const hostMarker = `# Reindeer Coder - ${hostName}`;
			const lines = configContent.split('\n');
			const filteredLines: string[] = [];
			let skipUntilNextHost = false;

			for (const line of lines) {
				if (line.trim() === hostMarker) {
					skipUntilNextHost = true;
					continue;
				} else if (skipUntilNextHost && line.trim().startsWith('Host ')) {
					// We've reached a different Host entry, stop skipping
					skipUntilNextHost = false;
				}

				if (!skipUntilNextHost) {
					filteredLines.push(line);
				}
			}

			// Write updated config
			const updatedConfig = filteredLines.join('\n');
			await fs.writeFile(this.sshConfigPath, updatedConfig, { mode: 0o600 });

			this.outputChannel.appendLine(`[SSH-CONFIG] ✓ Successfully removed host: ${hostName}`);
		} catch (error) {
			this.outputChannel.appendLine(`\n[SSH-CONFIG ERROR] Failed to remove SSH config:`);
			this.outputChannel.appendLine(`  Error: ${error}`);
			// Don't throw - removing is best-effort
		}
	}

	/**
	 * Get the host name for a task
	 */
	getHostName(taskId: string): string {
		return `reindeer-${taskId.substring(0, 8)}`;
	}
}
