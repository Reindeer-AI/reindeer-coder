import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CliError } from './util.js';
import { parseConnectionInfo } from './gcloud.js';

describe('parseConnectionInfo', () => {
	it('parses a canonical container_shell_command', () => {
		const target = parseConnectionInfo({
			container_shell_command:
				"gcloud compute ssh env-abc-123 --zone=us-central1-a --project=reindeer-vibe --tunnel-through-iap -- -t 'sudo devcontainer exec --workspace-folder /workspace bash -l'",
		});
		assert.equal(target.vm, 'env-abc-123');
		assert.equal(target.zone, 'us-central1-a');
		assert.equal(target.project, 'reindeer-vibe');
		assert.equal(
			target.innerCommand,
			'sudo devcontainer exec --workspace-folder /workspace bash -l',
		);
	});

	it('falls back to ssh_command when container_shell_command is absent', () => {
		const target = parseConnectionInfo({
			ssh_command:
				'gcloud compute ssh my-vm --zone=europe-west1-b --project=my-project --tunnel-through-iap',
		});
		assert.equal(target.vm, 'my-vm');
		assert.equal(target.zone, 'europe-west1-b');
		assert.equal(target.project, 'my-project');
		assert.equal(target.innerCommand, undefined);
	});

	it('prefers container_shell_command over ssh_command when both present', () => {
		const target = parseConnectionInfo({
			ssh_command:
				'gcloud compute ssh vm-a --zone=us-east1-b --project=proj-a --tunnel-through-iap',
			container_shell_command:
				"gcloud compute ssh vm-b --zone=us-west1-a --project=proj-b --tunnel-through-iap -- -t 'bash'",
		});
		assert.equal(target.vm, 'vm-b');
		assert.equal(target.zone, 'us-west1-a');
		assert.equal(target.project, 'proj-b');
	});

	it('throws ENV_NOT_READY when connection_info is null', () => {
		assert.throws(
			() => parseConnectionInfo(null),
			(err: unknown) => err instanceof CliError && err.code === 6,
		);
	});

	it('throws ENV_NOT_READY when both command fields are missing', () => {
		assert.throws(
			() => parseConnectionInfo({}),
			(err: unknown) => err instanceof CliError && err.code === 6,
		);
	});

	it('throws GCLOUD when the command is not a gcloud ssh invocation', () => {
		assert.throws(
			() =>
				parseConnectionInfo({
					container_shell_command: 'ssh root@example.com',
				}),
			(err: unknown) => err instanceof CliError && err.code === 5,
		);
	});

	it('throws GCLOUD when zone is missing', () => {
		assert.throws(
			() =>
				parseConnectionInfo({
					container_shell_command:
						'gcloud compute ssh my-vm --project=my-project --tunnel-through-iap',
				}),
			(err: unknown) => err instanceof CliError && err.code === 5,
		);
	});

	it('throws GCLOUD when project is missing', () => {
		assert.throws(
			() =>
				parseConnectionInfo({
					container_shell_command:
						'gcloud compute ssh my-vm --zone=us-central1-a --tunnel-through-iap',
				}),
			(err: unknown) => err instanceof CliError && err.code === 5,
		);
	});
});
