import { readFileSync } from 'node:fs';
import type { ApiClient } from '../api.js';
import { CliError, ExitCode, log, out } from '../util.js';

export interface SpecCreateOptions {
	name: string;
	from: string;
}

export async function specCreateCommand(
	api: ApiClient,
	opts: SpecCreateOptions,
): Promise<void> {
	const devcontainerJson = readDevcontainer(opts.from);

	log(`Creating spec "${opts.name}" from ${opts.from === '-' ? 'stdin' : opts.from}...`);
	const spec = await api.createSpec({
		name: opts.name,
		devcontainer_json: devcontainerJson,
	});

	out(spec.id);
	log(`Created spec ${spec.id}`);
}

/**
 * Read a devcontainer.json from a file path (or stdin if path is "-") and
 * verify it parses as JSON. We do the validation client-side so users get a
 * clear error before the round-trip to the server.
 */
function readDevcontainer(path: string): string {
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
