import { createInterface } from 'node:readline/promises';
import type { ApiClient } from '../api.js';
import { CliError, ExitCode, log } from '../util.js';

export interface SpecDeleteOptions {
	yes: boolean;
}

export async function specDeleteCommand(
	api: ApiClient,
	ref: string,
	opts: SpecDeleteOptions,
): Promise<void> {
	const spec = await api.resolveSpec(ref);

	if (!opts.yes) {
		const confirmed = await confirm(`Delete spec "${spec.name}" (${spec.id})? [y/N] `);
		if (!confirmed) {
			throw new CliError('Aborted', ExitCode.USAGE);
		}
	}

	await api.deleteSpec(spec.id);
	log(`Deleted ${spec.id}`);
}

async function confirm(prompt: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(prompt)).trim().toLowerCase();
		return answer === 'y' || answer === 'yes';
	} finally {
		rl.close();
	}
}
