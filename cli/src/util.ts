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

export function fail(message: string, code: number = ExitCode.USAGE): never {
	throw new CliError(message, code);
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
