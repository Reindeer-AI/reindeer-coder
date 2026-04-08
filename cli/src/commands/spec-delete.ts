import type { ApiClient } from '../api.js';
import { CliError, ExitCode, confirm, log } from '../util.js';

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
