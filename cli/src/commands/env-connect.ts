import type { ApiClient } from '../api.js';
import { execGcloudSsh, parseConnectionInfo } from '../gcloud.js';
import { CliError, ExitCode, log, out } from '../util.js';

export interface EnvConnectOptions {
	printSsh: boolean;
	/** Override for how long to wait when auto-starting a stopped env. */
	timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 5 * 60;

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
		env = await api.waitForEnvReady(id, {
			timeoutMs: (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
			onStatus: (status) => log(`  status: ${status}`),
		});
	} else if (env.status === 'pending' || env.status === 'provisioning') {
		log(`Environment is ${env.status} — waiting for ready...`);
		env = await api.waitForEnvReady(id, {
			timeoutMs: (opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
			onStatus: (status) => log(`  status: ${status}`),
		});
	} else if (env.status === 'failed' || env.status === 'deleted') {
		throw new CliError(
			`Environment ${id} is in terminal state ${env.status}`,
			ExitCode.ENV_NOT_READY,
		);
	}

	const target = parseConnectionInfo(env.connection_info);

	if (opts.printSsh) {
		// Print one argv element per line so shell copy-paste is unambiguous
		// regardless of what quoting the inner command uses.
		out('gcloud \\');
		out('  compute \\');
		out('  ssh \\');
		out(`  ${target.vm} \\`);
		out(`  --zone=${target.zone} \\`);
		out(`  --project=${target.project} \\`);
		if (target.innerCommand) {
			out('  --tunnel-through-iap \\');
			out('  -- \\');
			out('  -t \\');
			out(`  ${JSON.stringify(target.innerCommand)}`);
		} else {
			out('  --tunnel-through-iap');
		}
		return 0;
	}

	log(`Connecting to ${env.name} (${target.vm} in ${target.zone})...`);
	return execGcloudSsh(target, { interactive: true });
}
