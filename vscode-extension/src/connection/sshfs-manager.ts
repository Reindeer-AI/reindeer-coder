import { exec } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';

const execAsync = promisify(exec);

export interface MountOptions {
	vmName: string;
	zone: string;
	project: string;
	remotePath: string;
	localPath?: string;
	vmUser?: string;
}

export class SSHFSManager {
	private mounts: Map<string, string> = new Map(); // taskId -> localPath

	constructor(private readonly outputChannel: vscode.OutputChannel) {}

	/**
	 * Mount a remote filesystem using gcloud compute ssh and SSHFS
	 */
	async mount(taskId: string, options: MountOptions): Promise<string> {
		try {
			this.outputChannel.appendLine(`\n[SSHFS] Mount request for task ${taskId}`);
			this.outputChannel.appendLine(`[SSHFS] VM: ${options.vmName}`);
			this.outputChannel.appendLine(`[SSHFS] Zone: ${options.zone}`);
			this.outputChannel.appendLine(`[SSHFS] Project: ${options.project}`);
			this.outputChannel.appendLine(`[SSHFS] Remote path: ${options.remotePath}`);

			// Check if already mounted
			if (this.mounts.has(taskId)) {
				const existingPath = this.mounts.get(taskId)!;
				this.outputChannel.appendLine(`[SSHFS] Task ${taskId} already mounted at ${existingPath}`);
				return existingPath;
			}

			// Determine local mount path
			const localPath = options.localPath || path.join(os.tmpdir(), 'reindeer-coder', taskId);
			this.outputChannel.appendLine(`[SSHFS] Local mount path: ${localPath}`);

			// Create mount directory
			this.outputChannel.appendLine(`[SSHFS] Creating mount directory...`);
			await this.ensureDirectory(localPath);

			// Check if this path is already mounted (in case extension restarted)
			const isMounted = await this.checkIfMounted(localPath);
			if (isMounted) {
				this.outputChannel.appendLine(
					`[SSHFS] Path ${localPath} is already mounted, reusing existing mount`
				);
				this.mounts.set(taskId, localPath);
				return localPath;
			}

			// Check prerequisites
			this.outputChannel.appendLine(`[SSHFS] Checking prerequisites...`);
			await this.checkPrerequisites();
			this.outputChannel.appendLine(`[SSHFS] Prerequisites check passed`);

			// Build SSHFS command using gcloud compute ssh
			const sshfsCommand = this.buildSSHFSCommand(options, localPath);

			this.outputChannel.appendLine(`[SSHFS] Executing mount command:`);
			this.outputChannel.appendLine(`  ${sshfsCommand}`);

			const result = await execAsync(sshfsCommand);

			this.outputChannel.appendLine(`[SSHFS] Command stdout: ${result.stdout}`);
			if (result.stderr) {
				this.outputChannel.appendLine(`[SSHFS] Command stderr: ${result.stderr}`);
			}

			this.mounts.set(taskId, localPath);
			this.outputChannel.appendLine(`[SSHFS] ✓ Successfully mounted to ${localPath}`);

			return localPath;
		} catch (error) {
			this.outputChannel.appendLine(`\n[SSHFS ERROR] Failed to mount:`);
			this.outputChannel.appendLine(`  Error: ${error}`);
			if (error && typeof error === 'object') {
				const execError = error as any;
				if (execError.stdout) {
					this.outputChannel.appendLine(`  stdout: ${execError.stdout}`);
				}
				if (execError.stderr) {
					this.outputChannel.appendLine(`  stderr: ${execError.stderr}`);
				}
				if (execError.code) {
					this.outputChannel.appendLine(`  exit code: ${execError.code}`);
				}
			}
			throw new Error(`Failed to mount remote filesystem: ${error}`);
		}
	}

	/**
	 * Unmount a previously mounted filesystem
	 */
	async unmount(taskId: string): Promise<void> {
		const localPath = this.mounts.get(taskId);
		if (!localPath) {
			this.outputChannel.appendLine(`No mount found for task ${taskId}`);
			return;
		}

		try {
			this.outputChannel.appendLine(`Unmounting ${localPath}...`);

			// Platform-specific unmount command
			const unmountCmd = this.getUnmountCommand(localPath);
			await execAsync(unmountCmd);

			this.mounts.delete(taskId);
			this.outputChannel.appendLine(`Successfully unmounted ${localPath}`);
		} catch (error) {
			this.outputChannel.appendLine(`Failed to unmount: ${error}`);
			// Still remove from map even if unmount failed
			this.mounts.delete(taskId);
		}
	}

	/**
	 * Unmount all mounted filesystems
	 */
	async unmountAll(): Promise<void> {
		const taskIds = Array.from(this.mounts.keys());
		for (const taskId of taskIds) {
			await this.unmount(taskId);
		}
	}

	/**
	 * Get the local mount path for a task
	 */
	getMountPath(taskId: string): string | undefined {
		return this.mounts.get(taskId);
	}

	/**
	 * Check if required tools are installed
	 */
	private async checkPrerequisites(): Promise<void> {
		const platform = os.platform();
		this.outputChannel.appendLine(`[SSHFS] Platform: ${platform}`);

		// Check gcloud
		try {
			const gcloudResult = await execAsync('gcloud --version');
			this.outputChannel.appendLine(
				`[SSHFS] gcloud version: ${gcloudResult.stdout.split('\n')[0]}`
			);
		} catch (_error) {
			this.outputChannel.appendLine(`[SSHFS ERROR] gcloud not found`);
			throw new Error('gcloud CLI not found. Please install Google Cloud SDK.');
		}

		// Check SSHFS (platform-specific)
		try {
			let checkCmd = 'which sshfs';
			if (platform === 'win32') {
				checkCmd = 'where sshfs';
			}

			const sshfsResult = await execAsync(checkCmd);
			this.outputChannel.appendLine(`[SSHFS] sshfs found at: ${sshfsResult.stdout.trim()}`);
		} catch (_error) {
			this.outputChannel.appendLine(`[SSHFS ERROR] sshfs not found`);
			this.outputChannel.appendLine(`[SSHFS] Install instructions:`);
			if (platform === 'darwin') {
				this.outputChannel.appendLine(`  macOS: brew install macfuse sshfs`);
			} else if (platform === 'linux') {
				this.outputChannel.appendLine(`  Linux: sudo apt-get install sshfs`);
			} else if (platform === 'win32') {
				this.outputChannel.appendLine(
					`  Windows: Install from https://github.com/winfsp/sshfs-win`
				);
			}
			throw new Error('SSHFS not found. Please install SSHFS for your platform.');
		}
	}

	/**
	 * Build the SSHFS command using gcloud IAP tunnel
	 */
	private buildSSHFSCommand(options: MountOptions, localPath: string): string {
		const { vmName, zone, project, remotePath, vmUser } = options;

		// Use the VM user from options (should be provided by server config)
		const user = vmUser || 'agent';

		// Determine SSH identity file path based on platform
		const homeDir = os.homedir();
		const identityFile = `${homeDir}/.ssh/google_compute_engine`;

		// Build SSHFS command with gcloud IAP tunnel as ProxyCommand
		// This uses gcloud compute start-iap-tunnel which handles IAP tunneling properly
		const sshfsCmd = [
			'sshfs',
			`-o ProxyCommand="gcloud compute start-iap-tunnel ${vmName} %p --listen-on-stdin --project=${project} --zone=${zone}"`,
			`-o StrictHostKeyChecking=no`,
			`-o UserKnownHostsFile=/dev/null`,
			`-o IdentityFile=${identityFile}`,
			`-o reconnect`,
			`-o ServerAliveInterval=15`,
			`-o ServerAliveCountMax=3`,
			`${user}@${vmName}:${remotePath}`,
			`"${localPath}"`,
		].join(' ');

		return sshfsCmd;
	}

	/**
	 * Get platform-specific unmount command
	 */
	private getUnmountCommand(localPath: string): string {
		const platform = os.platform();

		if (platform === 'darwin') {
			return `umount "${localPath}"`;
		} else if (platform === 'linux') {
			return `fusermount -u "${localPath}"`;
		} else if (platform === 'win32') {
			return `sshfs -u "${localPath}"`;
		}

		throw new Error(`Unsupported platform: ${platform}`);
	}

	/**
	 * Ensure directory exists
	 */
	private async ensureDirectory(dirPath: string): Promise<void> {
		const fs = require('node:fs').promises;
		try {
			await fs.mkdir(dirPath, { recursive: true });
		} catch (error) {
			if ((error as any).code !== 'EEXIST') {
				throw error;
			}
		}
	}

	/**
	 * Check if a path is mounted (tracked by extension)
	 */
	isMounted(taskId: string): boolean {
		return this.mounts.has(taskId);
	}

	/**
	 * Check if a path is actually mounted on the filesystem
	 */
	private async checkIfMounted(mountPath: string): Promise<boolean> {
		const platform = os.platform();

		try {
			if (platform === 'darwin' || platform === 'linux') {
				// Use mount command to check if path is mounted
				const { stdout } = await execAsync('mount');
				return stdout.includes(mountPath);
			} else if (platform === 'win32') {
				// On Windows, check if directory is not empty (simple heuristic)
				const fs = require('node:fs').promises;
				try {
					const files = await fs.readdir(mountPath);
					return files.length > 0;
				} catch {
					return false;
				}
			}
			return false;
		} catch (error) {
			this.outputChannel.appendLine(`[SSHFS] Error checking mount status: ${error}`);
			return false;
		}
	}
}
