import { createInterface } from 'node:readline/promises';
import type { ApiClient } from '../api.js';
import { CliError, ExitCode, log } from '../util.js';

export interface EnvDeleteOptions {
	yes: boolean;
}

export async function envDeleteCommand(
	api: ApiClient,
	id: string,
	opts: EnvDeleteOptions,
): Promise<void> {
	const env = await api.getEnvironment(id);

	if (!opts.yes) {
		const confirmed = await confirm(
			`Delete environment "${env.name}" (${env.id}, status=${env.status})? [y/N] `,
		);
		if (!confirmed) {
			throw new CliError('Aborted', ExitCode.USAGE);
		}
	}

	await api.deleteEnvironment(id);
	log(`Deleted ${id}`);
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
