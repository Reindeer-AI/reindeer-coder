import { spawn } from 'node:child_process';
import { env } from '$env/dynamic/private';

// Use Bun's built-in Terminal API for PTY support
// This avoids node-pty compatibility issues with Bun runtime

// Type declarations for Bun's Terminal API (to avoid global bun-types conflicting with Vite types)
interface BunTerminal {
	write: (data: string | Uint8Array) => void;
	resize: (cols: number, rows: number) => void;
	close: () => void;
}

interface BunTerminalOptions {
	cols?: number;
	rows?: number;
	name?: string;
	data?: (terminal: BunTerminal, data: Uint8Array) => void;
	exit?: (terminal: BunTerminal, exitCode: number, signal: string | null) => void;
}

interface BunSubprocess {
	terminal: BunTerminal;
	pid: number;
	exited: Promise<number>;
	kill: (signal?: number) => void;
}

interface BunSpawnOptions {
	cwd?: string;
	env?: Record<string, string>;
	terminal?: BunTerminalOptions;
}

declare const Bun: {
	spawn: (cmd: string[], options?: BunSpawnOptions) => BunSubprocess;
};

export interface GcloudConnection {
	process: BunSubprocess;
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
 * Uses Bun.Terminal for proper PTY allocation (required for interactive CLI tools)
 */
export function connectToVM(vmName: string, zone?: string, project?: string): GcloudConnection {
	const gcpZone = zone || env.GCP_ZONE || 'us-central1-a';
	const gcpProject = project || env.GCP_PROJECT_ID;

	if (!gcpProject) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}

	// Build gcloud compute ssh command
	const cmd = [
		'gcloud',
		'compute',
		'ssh',
		vmName,
		`--zone=${gcpZone}`,
		`--project=${gcpProject}`,
		'--tunnel-through-iap',
		'--quiet', // Skip prompts
	];

	console.log(`[gcloud] Spawning SSH with Bun.Terminal: ${cmd.join(' ')}`);

	const dataCallbacks: ((data: string) => void)[] = [];
	const errorCallbacks: ((error: Error) => void)[] = [];
	const closeCallbacks: ((code: number | null) => void)[] = [];

	// Use Bun.spawn with terminal option for proper PTY allocation
	// This is Bun's native PTY implementation, avoiding node-pty compatibility issues
	const proc = Bun.spawn(cmd, {
		cwd: process.cwd(),
		env: process.env as Record<string, string>,
		terminal: {
			cols: 120,
			rows: 40,
			name: 'xterm-256color',
			data(_terminal: BunTerminal, data: Uint8Array) {
				const str = new TextDecoder().decode(data);
				console.log(`[gcloud:pty] ${str.substring(0, 200)}${str.length > 200 ? '...' : ''}`);
				dataCallbacks.forEach((cb) => {
					cb(str);
				});
			},
			exit(_terminal: BunTerminal, exitCode: number, signal: string | null) {
				console.log(`[gcloud:close] PTY process exited with code ${exitCode}, signal ${signal}`);
				closeCallbacks.forEach((cb) => {
					cb(exitCode);
				});
			},
		},
	}) as BunSubprocess;

	// Also handle process exit via the exited promise
	proc.exited
		.then((exitCode) => {
			console.log(`[gcloud:exited] Process exited with code ${exitCode}`);
		})
		.catch((err) => {
			console.error(`[gcloud:error] Process error:`, err);
			errorCallbacks.forEach((cb) => {
				cb(err);
			});
		});

	return {
		process: proc,
		vmName,
		zone: gcpZone,
		project: gcpProject,
		write: (data: string) => {
			proc.terminal.write(data);
		},
		resize: (cols: number, rows: number) => {
			console.log(`[gcloud:resize] Resizing PTY to ${cols}x${rows}`);
			proc.terminal.resize(cols, rows);
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
			proc.terminal.close();
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
