import { spawn } from 'node:child_process';

/**
 * Execute a gcloud CLI command and return stdout.
 * Shared helper used by both task orchestrator and environment orchestrator.
 */
export async function gcloud(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn('gcloud', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';

		proc.stdout?.on('data', (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr?.on('data', (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on('error', reject);
		proc.on('close', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`gcloud failed (code ${code}): ${stderr}`));
			}
		});
	});
}
