import type { ApiClient, Environment } from '../api.js';
import { CliError, ExitCode, log, out } from '../util.js';

export interface EnvCreateOptions {
	spec: string;
	name: string;
	machineType?: string;
	wait: boolean;
}

const READY_STATES = new Set(['ready']);
const FAILED_STATES = new Set(['failed', 'deleted']);
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export async function envCreateCommand(
	api: ApiClient,
	opts: EnvCreateOptions,
): Promise<void> {
	const spec = await api.resolveSpec(opts.spec);

	log(`Creating environment "${opts.name}" from spec "${spec.name}"...`);
	const created = await api.createEnvironment({
		spec_id: spec.id,
		name: opts.name,
		machine_type: opts.machineType,
	});

	if (!opts.wait) {
		out(created.id);
		return;
	}

	const ready = await waitForReady(api, created.id);
	out(ready.id);
	log(`Environment ready: ${ready.id} (${ready.status})`);
}

async function waitForReady(api: ApiClient, id: string): Promise<Environment> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	let lastStatus = '';

	while (Date.now() < deadline) {
		const env = await api.getEnvironment(id);
		if (env.status !== lastStatus) {
			log(`  status: ${env.status}`);
			lastStatus = env.status;
		}
		if (READY_STATES.has(env.status)) {
			return env;
		}
		if (FAILED_STATES.has(env.status)) {
			throw new CliError(
				`Environment ${id} entered terminal state: ${env.status}`,
				ExitCode.ENV_NOT_READY,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}

	throw new CliError(
		`Environment ${id} did not become ready within ${POLL_TIMEOUT_MS / 1000}s`,
		ExitCode.ENV_NOT_READY,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
