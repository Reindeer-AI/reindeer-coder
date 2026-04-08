import type { ApiClient } from '../api.js';
import { log, out, readDevcontainerFile } from '../util.js';

export interface SpecCreateOptions {
	name: string;
	from: string;
}

export async function specCreateCommand(
	api: ApiClient,
	opts: SpecCreateOptions,
): Promise<void> {
	const devcontainerJson = readDevcontainerFile(opts.from);

	log(`Creating spec "${opts.name}" from ${opts.from === '-' ? 'stdin' : opts.from}...`);
	const spec = await api.createSpec({
		name: opts.name,
		devcontainer_json: devcontainerJson,
	});

	out(spec.id);
	log(`Created spec ${spec.id}`);
}
