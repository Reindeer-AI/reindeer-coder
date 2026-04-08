import type { ApiClient, SpecUpdateInput } from '../api.js';
import { CliError, ExitCode, log, readDevcontainerFile } from '../util.js';

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
		input.devcontainer_json = readDevcontainerFile(opts.from);
	}

	const updated = await api.updateSpec(spec.id, input);
	log(`Updated spec ${updated.id}`);
}
