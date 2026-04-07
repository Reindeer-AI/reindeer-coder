import type { ApiClient, Environment } from '../api.js';
import { execGcloudSsh, parseConnectionInfo } from '../gcloud.js';
import { CliError, ExitCode, log } from '../util.js';

export interface EnvConnectOptions {
	printSsh: boolean;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

export async function envConnectCommand(
	api: ApiClient,
	id: string,
	opts: EnvConnectOptions,
): Promise<number> {
	let env = await api.getEnvironment(id);

	// If the env is stopped or pending, kick it and wait for ready.
	if (env.status === 'stopped') {
		log(`Environment is stopped — starting...`);
		await api.startEnvironment(id);
		env = await waitForReady(api, id);
	} else if (env.status === 'pending' || env.status === 'provisioning') {
		log(`Environment is ${env.status} — waiting for ready...`);
		env = await waitForReady(api, id);
	} else if (env.status === 'failed' || env.status === 'deleted') {
		throw new CliError(
			`Environment ${id} is in terminal state ${env.status}`,
			ExitCode.ENV_NOT_READY,
		);
	}

	const target = parseConnectionInfo(env.connection_info);

	if (opts.printSsh) {
		const inner = target.innerCommand ? ` -- -t '${target.innerCommand}'` : '';
		log(
			`gcloud compute ssh ${target.vm} --zone=${target.zone} --project=${target.project} --tunnel-through-iap${inner}`,
		);
		return 0;
	}

	log(`Connecting to ${env.name} (${target.vm} in ${target.zone})...`);
	return execGcloudSsh(target, { interactive: true });
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
		if (env.status === 'ready') {
			return env;
		}
		if (env.status === 'failed' || env.status === 'deleted') {
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
