#!/usr/bin/env node
import { Command } from 'commander';
import { ApiClient } from './api.js';
import { getValidAccessToken } from './auth.js';
import { envConnectCommand } from './commands/env-connect.js';
import { envCreateCommand } from './commands/env-create.js';
import { envDeleteCommand } from './commands/env-delete.js';
import { envListCommand } from './commands/env-list.js';
import { loginCommand } from './commands/login.js';
import { specCreateCommand } from './commands/spec-create.js';
import { specDeleteCommand } from './commands/spec-delete.js';
import { specGetCommand } from './commands/spec-get.js';
import { specListCommand } from './commands/spec-list.js';
import { specUpdateCommand } from './commands/spec-update.js';
import { resolveServer } from './config.js';
import { CliError, ExitCode, log } from './util.js';

interface GlobalOptions {
	server?: string;
}

/**
 * Build an API client for the resolved server. The token is read (and
 * refreshed if necessary) once up front; a single CLI invocation is
 * short-lived enough that we don't need on-demand refresh mid-run.
 */
async function buildApiClient(globalOpts: GlobalOptions): Promise<ApiClient> {
	const server = resolveServer(globalOpts.server);
	const token = await getValidAccessToken(server);
	return new ApiClient(server, () => token);
}

function parseTimeoutSeconds(raw: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new CliError(`--timeout must be a positive number of seconds (got "${raw}")`);
	}
	return Math.floor(n);
}

async function main(): Promise<void> {
	const program = new Command();

	program
		.name('vibe')
		.description('Command-line interface for reindeer-coder')
		.version('0.1.0')
		.option('--server <url>', 'override reindeer-coder server URL')
		.showHelpAfterError();

	program
		.command('login')
		.description('Authenticate against reindeer-coder')
		.option('--server <url>', 'reindeer-coder server URL (saved on first login)')
		.action(async (cmdOpts: { server?: string }) => {
			const globalOpts = program.opts<GlobalOptions>();
			await loginCommand({ server: cmdOpts.server ?? globalOpts.server });
		});

	const env = program.command('env').description('Manage remote dev environments');

	env
		.command('list')
		.alias('ls')
		.description('List your environments')
		.action(async () => {
			const api = await buildApiClient(program.opts<GlobalOptions>());
			await envListCommand(api);
		});

	env
		.command('create')
		.description('Create a new environment from a spec')
		.requiredOption('--spec <spec>', 'spec id or name')
		.requiredOption('--name <name>', 'human-readable environment name')
		.option('-d, --description <text>', 'longer human-readable description (max 500 chars)')
		.option('--machine-type <type>', 'GCP machine type override')
		.option('--zone <zone>', 'GCP zone override, e.g. us-central1-a, europe-west1-b')
		.option('--no-wait', 'return immediately without polling for ready')
		.option('--timeout <seconds>', 'max wait for ready (default 600)', parseTimeoutSeconds)
		.action(
			async (cmdOpts: {
				spec: string;
				name: string;
				description?: string;
				machineType?: string;
				zone?: string;
				wait: boolean;
				timeout?: number;
			}) => {
				const api = await buildApiClient(program.opts<GlobalOptions>());
				await envCreateCommand(api, {
					spec: cmdOpts.spec,
					name: cmdOpts.name,
					description: cmdOpts.description,
					machineType: cmdOpts.machineType,
					zone: cmdOpts.zone,
					wait: cmdOpts.wait,
					timeoutSeconds: cmdOpts.timeout,
				});
			}
		);

	env
		.command('delete <env-id>')
		.description('Delete an environment')
		.option('-y, --yes', 'skip confirmation prompt')
		.action(async (id: string, cmdOpts: { yes?: boolean }) => {
			const api = await buildApiClient(program.opts<GlobalOptions>());
			await envDeleteCommand(api, id, { yes: cmdOpts.yes ?? false });
		});

	env
		.command('connect <env-id>')
		.description('SSH into the environment’s devcontainer')
		.option('--print-ssh', 'print the gcloud command instead of executing it')
		.option('--timeout <seconds>', 'max wait when auto-starting (default 300)', parseTimeoutSeconds)
		.action(async (id: string, cmdOpts: { printSsh?: boolean; timeout?: number }) => {
			const api = await buildApiClient(program.opts<GlobalOptions>());
			const code = await envConnectCommand(api, id, {
				printSsh: cmdOpts.printSsh ?? false,
				timeoutSeconds: cmdOpts.timeout,
			});
			process.exit(code);
		});

	const spec = program.command('spec').description('Manage devcontainer specs');

	spec
		.command('list')
		.alias('ls')
		.description('List your specs')
		.action(async () => {
			const api = await buildApiClient(program.opts<GlobalOptions>());
			await specListCommand(api);
		});

	spec
		.command('get <spec>')
		.description('Show spec details (by id or name)')
		.option('--content', 'print only the devcontainer.json contents (pipeable)')
		.action(async (ref: string, cmdOpts: { content?: boolean }) => {
			const api = await buildApiClient(program.opts<GlobalOptions>());
			await specGetCommand(api, ref, { content: cmdOpts.content ?? false });
		});

	spec
		.command('create')
		.description('Create a new spec from a devcontainer.json file')
		.requiredOption('--name <name>', 'human-readable spec name')
		.requiredOption('--from <file>', 'path to devcontainer.json (use "-" for stdin)')
		.action(async (cmdOpts: { name: string; from: string }) => {
			const api = await buildApiClient(program.opts<GlobalOptions>());
			await specCreateCommand(api, cmdOpts);
		});

	spec
		.command('update <spec>')
		.description('Update a spec name and/or content')
		.option('--name <name>', 'new spec name')
		.option('--from <file>', 'replacement devcontainer.json (use "-" for stdin)')
		.action(async (ref: string, cmdOpts: { name?: string; from?: string }) => {
			const api = await buildApiClient(program.opts<GlobalOptions>());
			await specUpdateCommand(api, ref, cmdOpts);
		});

	spec
		.command('delete <spec>')
		.description('Delete a spec (by id or name)')
		.option('-y, --yes', 'skip confirmation prompt')
		.action(async (ref: string, cmdOpts: { yes?: boolean }) => {
			const api = await buildApiClient(program.opts<GlobalOptions>());
			await specDeleteCommand(api, ref, { yes: cmdOpts.yes ?? false });
		});

	await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
	if (err instanceof CliError) {
		log(`error: ${err.message}`);
		process.exit(err.code);
	}
	log(`error: ${(err as Error).message ?? err}`);
	process.exit(ExitCode.USAGE);
});
