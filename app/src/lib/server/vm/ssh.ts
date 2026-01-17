// @ts-ignore - Optional dependency, only needed for SSH-based VM connections
import { Client, type ClientChannel } from 'ssh2';
import fs from 'fs';

export type SSHConnection = Client;

const SSH_USER = 'vibe';
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH || '';

interface CommandCallbacks {
	onStdout?: (data: string) => void;
	onStderr?: (data: string) => void;
	onClose?: (code: number | null) => void;
	onError?: (err: Error) => void;
}

/**
 * Connect to a VM via SSH
 */
export async function connectSSH(
	host: string,
	port = 22,
	maxRetries = 10,
	retryDelayMs = 5000
): Promise<SSHConnection> {
	const privateKey = fs.readFileSync(SSH_PRIVATE_KEY_PATH);

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await tryConnect(host, port, privateKey);
		} catch (err) {
			console.warn(`SSH connection attempt ${attempt}/${maxRetries} failed:`, err);
			if (attempt === maxRetries) {
				throw new Error(`Failed to connect to ${host} after ${maxRetries} attempts`);
			}
			await sleep(retryDelayMs);
		}
	}

	throw new Error('Unreachable');
}

function tryConnect(host: string, port: number, privateKey: Buffer): Promise<Client> {
	return new Promise((resolve, reject) => {
		const conn = new Client();

		conn.on('ready', () => {
			resolve(conn);
		});

		conn.on('error', (err: Error) => {
			reject(err);
		});

		conn.connect({
			host,
			port,
			username: SSH_USER,
			privateKey,
			readyTimeout: 30000,
			keepaliveInterval: 10000
		});
	});
}

/**
 * Execute a command over SSH and stream output
 */
export function executeCommand(
	conn: SSHConnection,
	command: string,
	callbacks: CommandCallbacks
): void {
	conn.exec(command, { pty: true }, (err: Error | undefined, stream: ClientChannel) => {
		if (err) {
			callbacks.onError?.(err);
			return;
		}

		stream.on('data', (data: Buffer) => {
			callbacks.onStdout?.(data.toString());
		});

		stream.stderr.on('data', (data: Buffer) => {
			callbacks.onStderr?.(data.toString());
		});

		stream.on('close', (code: number | null) => {
			callbacks.onClose?.(code);
		});

		stream.on('error', (err: Error) => {
			callbacks.onError?.(err);
		});
	});
}

/**
 * Execute a command and return the full output
 */
export function executeCommandSync(conn: SSHConnection, command: string): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';

		executeCommand(conn, command, {
			onStdout: (data) => { stdout += data; },
			onStderr: (data) => { stderr += data; },
			onClose: (code) => { resolve({ stdout, stderr, code: code || 0 }); },
			onError: (err) => { reject(err); }
		});
	});
}

/**
 * Write to stdin of a running command (for interactive PTY)
 */
export function writeToStream(stream: ClientChannel, data: string): void {
	stream.write(data);
}

/**
 * Start an interactive shell and return the stream
 */
export function startShell(conn: SSHConnection): Promise<ClientChannel> {
	return new Promise((resolve, reject) => {
		conn.shell({ term: 'xterm-256color' }, (err: Error | undefined, stream: ClientChannel) => {
			if (err) {
				reject(err);
				return;
			}
			resolve(stream);
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
