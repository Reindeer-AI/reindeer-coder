import { login } from '../auth.js';
import { readConfig, writeConfig } from '../config.js';
import { CliError, ExitCode, log, out } from '../util.js';

export interface LoginOptions {
	server?: string;
}

export async function loginCommand(opts: LoginOptions): Promise<void> {
	// Resolve server URL: explicit flag wins, then config file. We do NOT
	// fall back to $VIBE_SERVER here on purpose — `vibe login` is the place
	// you tell the CLI which deployment to remember.
	const existing = readConfig();
	const server = (opts.server ?? existing.server)?.replace(/\/+$/, '');
	if (!server) {
		throw new CliError(
			'No server specified. Run: vibe login --server https://your-instance.example.com',
			ExitCode.USAGE,
		);
	}

	// Persist the server choice up front so a failed login still leaves the
	// config in a usable state for the next attempt.
	if (existing.server !== server) {
		writeConfig({ ...existing, server });
		log(`Saved server: ${server}`);
	}

	const bundle = await login(server);
	out(`Logged in as ${bundle.email ?? bundle.sub ?? '(unknown user)'}`);
}
