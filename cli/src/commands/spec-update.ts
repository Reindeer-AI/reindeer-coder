import { readFileSync } from 'node:fs';
import type { ApiClient, SpecUpdateInput } from '../api.js';
import { CliError, ExitCode, log } from '../util.js';

export interface SpecUpdateOptions {
	name?: string;
	from?: string;
}

export async function specUpdateCommand(
	api: ApiClient,
	ref: string,
	opts: SpecUpdateOptions,
): Promise<void> {
	if (!opts.name && !opts.from) {
		throw new CliError(
			'Nothing to update. Pass --name <new-name> and/or --from <file>',
			ExitCode.USAGE,
		);
	}

	const spec = await api.resolveSpec(ref);

	const input: SpecUpdateInput = {};
	if (opts.name) {
		input.name = opts.name;
	}
	if (opts.from) {
		input.devcontainer_json = readDevcontainer(opts.from);
	}

	const updated = await api.updateSpec(spec.id, input);
	log(`Updated spec ${updated.id}`);
}

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
