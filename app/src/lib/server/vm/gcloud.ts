import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import { env } from '$env/dynamic/private';

export interface GcloudConnection {
	process: pty.IPty;
	vmName: string;
	zone: string;
	project: string;
	write: (data: string) => void;
	resize: (cols: number, rows: number) => void;
	onData: (callback: (data: string) => void) => void;
	onError: (callback: (error: Error) => void) => void;
	onClose: (callback: (code: number | null) => void) => void;
	close: () => void;
}

/**
 * Start an interactive SSH session to a GCP VM using gcloud compute ssh
 * This uses IAP tunneling so no SSH keys are needed
 * Uses node-pty for proper PTY allocation (required for interactive CLI tools)
 */
export function connectToVM(vmName: string, zone?: string, project?: string): GcloudConnection {
	const gcpZone = zone || env.GCP_ZONE || 'us-central1-a';
	const gcpProject = project || env.GCP_PROJECT_ID;

	if (!gcpProject) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}

	// Build gcloud compute ssh command arguments
	const args = [
		'compute',
		'ssh',
		vmName,
		`--zone=${gcpZone}`,
		`--project=${gcpProject}`,
		'--tunnel-through-iap',
		'--quiet', // Skip prompts
		'--ssh-flag=-o ServerAliveInterval=30', // Send keepalive every 30 seconds
		'--ssh-flag=-o ServerAliveCountMax=3', // After 3 failed keepalives, consider connection dead
	];

	console.log(`[gcloud] Spawning SSH with PTY: gcloud ${args.join(' ')}`);

	// Use node-pty for proper pseudo-terminal allocation
	// This is required for interactive CLI tools like claude-code
	const proc = pty.spawn('gcloud', args, {
		name: 'xterm-256color',
		cols: 120,
		rows: 40,
		cwd: process.cwd(),
		env: process.env as { [key: string]: string },
	});

	const dataCallbacks: ((data: string) => void)[] = [];
	const errorCallbacks: ((error: Error) => void)[] = [];
	const closeCallbacks: ((code: number | null) => void)[] = [];

	proc.onData((data: string) => {
		console.log(`[gcloud:pty] ${data.substring(0, 200)}${data.length > 200 ? '...' : ''}`);
		dataCallbacks.forEach((cb) => {
			cb(data);
		});
	});

	proc.onExit(({ exitCode }) => {
		console.log(`[gcloud:close] PTY process exited with code ${exitCode}`);
		closeCallbacks.forEach((cb) => {
			cb(exitCode);
		});
	});

	return {
		process: proc,
		vmName,
		zone: gcpZone,
		project: gcpProject,
		write: (data: string) => {
			proc.write(data);
		},
		resize: (cols: number, rows: number) => {
			console.log(`[gcloud:resize] Resizing PTY to ${cols}x${rows}`);
			proc.resize(cols, rows);
		},
		onData: (callback: (data: string) => void) => {
			dataCallbacks.push(callback);
		},
		onError: (callback: (error: Error) => void) => {
			errorCallbacks.push(callback);
		},
		onClose: (callback: (code: number | null) => void) => {
			closeCallbacks.push(callback);
		},
		close: () => {
			proc.kill();
		},
	};
}

/**
 * Execute a single command on a VM and return the output
 */
export async function execOnVM(
	vmName: string,
	command: string,
	zone?: string,
	project?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const gcpZone = zone || env.GCP_ZONE || 'us-central1-a';
	const gcpProject = project || env.GCP_PROJECT_ID;

	if (!gcpProject) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}

	const args = [
		'compute',
		'ssh',
		vmName,
		`--zone=${gcpZone}`,
		`--project=${gcpProject}`,
		'--tunnel-through-iap',
		'--quiet',
		'--command',
		command,
	];

	return new Promise((resolve, reject) => {
		const proc = spawn('gcloud', args, {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';

		proc.stdout?.on('data', (data: Buffer) => {
			stdout += data.toString();
		});

		proc.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on('error', reject);

		proc.on('close', (code: number | null) => {
			resolve({ stdout, stderr, exitCode: code || 0 });
		});
	});
}

/**
 * Copy a file to a VM using gcloud compute scp
 */
export async function copyToVM(
	vmName: string,
	localPath: string,
	remotePath: string,
	zone?: string,
	project?: string
): Promise<void> {
	const gcpZone = zone || env.GCP_ZONE || 'us-central1-a';
	const gcpProject = project || env.GCP_PROJECT_ID;

	if (!gcpProject) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}

	const args = [
		'compute',
		'scp',
		localPath,
		`${vmName}:${remotePath}`,
		`--zone=${gcpZone}`,
		`--project=${gcpProject}`,
		'--tunnel-through-iap',
		'--quiet',
	];

	return new Promise((resolve, reject) => {
		const proc = spawn('gcloud', args, {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let stderr = '';

		proc.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on('error', reject);

		proc.on('close', (code: number | null) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`scp failed with code ${code}: ${stderr}`));
			}
		});
	});
}

/**
 * Execute a command on a VM with streaming output
 * Calls onData callback for each chunk of stdout/stderr
 */
export async function execOnVMStreaming(
	vmName: string,
	command: string,
	onData: (data: string, stream: 'stdout' | 'stderr') => void,
	zone?: string,
	project?: string,
	timeout?: number
): Promise<{ exitCode: number }> {
	const gcpZone = zone || env.GCP_ZONE || 'us-central1-a';
	const gcpProject = project || env.GCP_PROJECT_ID;

	if (!gcpProject) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}

	const args = [
		'compute',
		'ssh',
		vmName,
		`--zone=${gcpZone}`,
		`--project=${gcpProject}`,
		'--tunnel-through-iap',
		'--quiet',
		'--command',
		command,
	];

	return new Promise((resolve, reject) => {
		const proc = spawn('gcloud', args, {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		let timeoutId: NodeJS.Timeout | undefined;

		// Set up timeout if specified
		if (timeout) {
			timeoutId = setTimeout(() => {
				proc.kill('SIGTERM');
				reject(new Error(`Command timed out after ${timeout}ms`));
			}, timeout);
		}

		// Stream stdout
		proc.stdout?.on('data', (data: Buffer) => {
			onData(data.toString(), 'stdout');
		});

		// Stream stderr
		proc.stderr?.on('data', (data: Buffer) => {
			onData(data.toString(), 'stderr');
		});

		proc.on('error', (error) => {
			if (timeoutId) clearTimeout(timeoutId);
			reject(error);
		});

		proc.on('close', (code: number | null) => {
			if (timeoutId) clearTimeout(timeoutId);
			resolve({ exitCode: code || 0 });
		});
	});
}
