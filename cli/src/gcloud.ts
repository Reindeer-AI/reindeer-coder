import { spawn } from 'node:child_process';
import type { EnvironmentConnectionInfo } from './api.js';
import { CliError, ExitCode } from './util.js';

/**
 * Coordinates parsed out of an env's connection_info.container_shell_command.
 *
 * The server stores commands like:
 *   gcloud compute ssh <vmName> --zone=<zone> --project=<project> --tunnel-through-iap -- -t '...'
 *
 * We parse these flags rather than re-deriving them from the env metadata so
 * the CLI stays in sync with whatever the server decides at provisioning time.
 *
 * TODO(REI-1169-followup): this reverse-parse is fragile — the regex assumes
 * single-quoted, no-nested-quote, no-newline inner commands. The right fix
 * is to expose structured fields (vm_name, zone, project, container_id,
 * workspace_folder) directly in EnvironmentConnectionInfo server-side and
 * drop the shell-string parsing entirely.
 */
export interface GcloudTarget {
	vm: string;
	zone: string;
	project: string;
	innerCommand?: string;
}

const FLAG_RE = /--(zone|project)=([^\s]+)/g;

export function parseConnectionInfo(info: EnvironmentConnectionInfo | null): GcloudTarget {
	const cmd = info?.container_shell_command ?? info?.ssh_command;
	if (!cmd) {
		throw new CliError(
			'Environment has no connection info yet — try again once it is ready',
			ExitCode.ENV_NOT_READY,
		);
	}

	// Extract VM name: first positional argument after `gcloud compute ssh`.
	const sshMatch = cmd.match(/gcloud\s+compute\s+ssh\s+(\S+)/);
	if (!sshMatch?.[1]) {
		throw new CliError(`Cannot parse gcloud command from: ${cmd}`, ExitCode.GCLOUD);
	}
	const vm = sshMatch[1];

	const flags: Record<string, string> = {};
	for (const match of cmd.matchAll(FLAG_RE)) {
		const key = match[1];
		const value = match[2];
		if (key && value) {
			flags[key] = value;
		}
	}

	const zone = flags.zone;
	const project = flags.project;
	if (!zone || !project) {
		throw new CliError(
			`Connection info missing zone or project: ${cmd}`,
			ExitCode.GCLOUD,
		);
	}

	// Pull out everything after `-- -t` if present, so we can re-use the inner command.
	const innerMatch = cmd.match(/--\s+-t\s+'(.+)'\s*$/);
	const innerCommand = innerMatch?.[1];

	return { vm, zone, project, innerCommand };
}

/**
 * Exec gcloud compute ssh with --tunnel-through-iap, attaching the user's TTY
 * directly to the gcloud subprocess. Resolves with the gcloud exit code.
 */
export function execGcloudSsh(
	target: GcloudTarget,
	options: { interactive?: boolean; remoteCommand?: string } = {},
): Promise<number> {
	const args = [
		'compute',
		'ssh',
		target.vm,
		`--zone=${target.zone}`,
		`--project=${target.project}`,
		'--tunnel-through-iap',
	];

	const remote = options.remoteCommand ?? target.innerCommand;
	if (remote) {
		args.push('--', '-t', remote);
	}

	return new Promise((resolve, reject) => {
		const child = spawn('gcloud', args, {
			stdio: options.interactive === false ? ['pipe', 'pipe', 'pipe'] : 'inherit',
		});

		child.on('error', (err) => {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(
					new CliError(
						'gcloud not found on PATH. Install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install',
						ExitCode.GCLOUD,
					),
				);
				return;
			}
			reject(new CliError(`gcloud failed: ${err.message}`, ExitCode.GCLOUD));
		});

		child.on('exit', (code, signal) => {
			if (signal) {
				resolve(128 + (signal === 'SIGINT' ? 2 : 15));
				return;
			}
			resolve(code ?? 0);
		});
	});
}
