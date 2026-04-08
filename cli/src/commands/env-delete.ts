import type { ApiClient } from '../api.js';
import { CliError, ExitCode, confirm, log } from '../util.js';

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
