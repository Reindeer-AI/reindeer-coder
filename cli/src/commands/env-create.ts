import type { ApiClient } from '../api.js';
import { log, out } from '../util.js';

export interface EnvCreateOptions {
	spec: string;
	name: string;
	description?: string;
	machineType?: string;
	zone?: string;
	wait: boolean;
	/** Override for the --wait poll deadline, in seconds. */
	timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 10 * 60;

export async function envCreateCommand(api: ApiClient, opts: EnvCreateOptions): Promise<void> {
	const spec = await api.resolveSpec(opts.spec);

	log(`Creating environment "${opts.name}" from spec "${spec.name}"...`);
	const created = await api.createEnvironment({
		spec_id: spec.id,
		name: opts.name,
		description: opts.description,
		machine_type: opts.machineType,
		zone: opts.zone,
	});

	if (!opts.wait) {
		out(created.id);
		return;
	}

	const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
	const ready = await api.waitForEnvReady(created.id, {
		timeoutMs: timeoutSeconds * 1000,
		onStatus: (status) => log(`  status: ${status}`),
	});
	out(ready.id);
	log(`Environment ready: ${ready.id} (${ready.status})`);
}
