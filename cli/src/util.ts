import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

/**
 * Exit codes used throughout the CLI. See README for the contract.
 */
export const ExitCode = {
	SUCCESS: 0,
	USAGE: 2,
	NETWORK: 3,
	AUTH: 4,
	GCLOUD: 5,
	ENV_NOT_READY: 6,
	NOT_FOUND: 7,
} as const;

export class CliError extends Error {
	constructor(
		message: string,
		readonly code: number = ExitCode.USAGE,
	) {
		super(message);
		this.name = 'CliError';
	}
}

/**
 * Print to stderr without a trailing exit. Use for status lines and errors.
 */
export function log(message: string): void {
	process.stderr.write(`${message}\n`);
}

/**
 * Print to stdout. Use for command output that may be piped or captured.
 */
export function out(message: string): void {
	process.stdout.write(`${message}\n`);
}

/**
 * Format an array of records as a fixed-width table for human reading.
 */
export function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
	);
	const fmt = (cells: string[]): string =>
		cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
	return [fmt(headers), ...rows.map(fmt)].join('\n');
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the user for yes/no confirmation on stderr. Returns true for y/yes.
 */
export async function confirm(prompt: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(prompt)).trim().toLowerCase();
		return answer === 'y' || answer === 'yes';
	} finally {
		rl.close();
	}
}

/**
 * Read a devcontainer.json from a path (or stdin if path is "-") and verify
 * it parses as JSON. We validate client-side so users get a clear error
 * before the round-trip to the server.
 */
export function readDevcontainerFile(path: string): string {
	let raw: string;
	try {
		raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
	} catch (err) {
		throw new CliError(
			`Cannot read ${path}: ${(err as Error).message}`,
			ExitCode.USAGE,
		);
	}
	try {
		JSON.parse(raw);
	} catch (err) {
		throw new CliError(
			`${path} is not valid JSON: ${(err as Error).message}`,
			ExitCode.USAGE,
		);
	}
	return raw;
}
