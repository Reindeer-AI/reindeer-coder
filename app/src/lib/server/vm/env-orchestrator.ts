import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import {
	getEnvironmentById,
	getSpecById,
	softDeleteEnvironment,
	updateEnvironmentConnectionInfo,
	updateEnvironmentStatus,
	updateEnvironmentVm,
} from '../db';
import { readSpecSecret } from '../specs/spec-store';
import { connectToVM, copyToVM, execOnVMStreaming } from './gcloud';
import { gcloud } from './gcloud-cli';
import { resolveMachineType } from './machine-type-resolver';

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test SSH connectivity by opening a connection, sending a command,
 * and checking for a shell prompt.
 */
async function waitForSSH(
	vmName: string,
	zone: string,
	project: string,
	opts: { maxAttempts?: number; sleepMs?: number; timeoutMs?: number } = {}
): Promise<boolean> {
	const { maxAttempts = 5, sleepMs = 30000, timeoutMs = 30000 } = opts;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		await sleep(sleepMs);

		try {
			const connected = await new Promise<boolean>((resolve) => {
				const testConn = connectToVM(vmName, zone, project);
				let done = false;
				const timeout = setTimeout(() => {
					testConn.close();
					resolve(false);
				}, timeoutMs);

				let buffer = '';
				testConn.onData((data) => {
					buffer += data;
					if (!done && buffer.includes('SSH_READY')) {
						done = true;
						clearTimeout(timeout);
						testConn.close();
						resolve(true);
					}
				});

				testConn.onClose(() => {
					clearTimeout(timeout);
					if (!done) resolve(false);
				});

				testConn.onError(() => {
					clearTimeout(timeout);
					resolve(false);
				});

				setTimeout(() => {
					testConn.write('echo "SSH_READY"\n');
				}, 5000);
			});

			if (connected) return true;
		} catch {
			console.log(`[env-orchestrator] SSH attempt ${attempt}/${maxAttempts} failed for ${vmName}`);
		}
	}

	return false;
}

function generateStartupScript(): string {
	return `#!/bin/bash
set -euo pipefail

echo "[env] Fetching devcontainer spec from Secret Manager..."
SPEC_SECRET=$(curl -sf "http://metadata.google.internal/computeMetadata/v1/instance/attributes/SPEC_SECRET_PATH" \\
  -H "Metadata-Flavor: Google")
SA=$(curl -sf "http://metadata.google.internal/computeMetadata/v1/instance/attributes/SECRET_IMPERSONATE_SA" \\
  -H "Metadata-Flavor: Google" || true)
IMPERSONATE=""
[ -n "$SA" ] && IMPERSONATE="--impersonate-service-account=$SA"

mkdir -p /workspace/.devcontainer
gcloud secrets versions access "$SPEC_SECRET" $IMPERSONATE \\
  > /workspace/.devcontainer/devcontainer.json

echo "[env] Installing Docker..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io curl git
systemctl enable --now docker

echo "[env] Installing Node.js + devcontainer CLI..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
npm install -g @devcontainers/cli

echo "[env] Building and starting devcontainer..."
devcontainer up --workspace-folder /workspace

echo "[env] Environment ready!"
touch /tmp/env_ready
`;
}

export async function provisionEnvironment(envId: string): Promise<void> {
	const environment = await getEnvironmentById(envId);
	if (!environment) {
		throw new Error(`Environment ${envId} not found`);
	}

	const spec = await getSpecById(environment.spec_id);
	if (!spec) {
		throw new Error(`Spec ${environment.spec_id} not found`);
	}

	const project = env.GCP_PROJECT_ID;
	const zone = env.GCP_ZONE || 'us-central1-a';
	const network = env.GCP_NETWORK;
	const subnet = env.GCP_SUBNET;
	const vmServiceAccount = env.GCP_VM_SERVICE_ACCOUNT;

	if (!project) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}

	const devcontainerJson = await readSpecSecret(spec.secret_path);
	const machineType = await resolveMachineType(
		devcontainerJson,
		environment.vm_machine_type || undefined
	);

	const vmName = `env-${envId.slice(0, 8)}-${Date.now()}`;
	const imageFamily = env.VM_IMAGE_FAMILY || 'ubuntu-2204-lts';
	const imageProject = env.VM_IMAGE_PROJECT || 'ubuntu-os-cloud';

	await updateEnvironmentVm(envId, vmName, zone, machineType);
	await updateEnvironmentStatus(envId, 'provisioning');

	try {
		const createArgs = [
			'compute',
			'instances',
			'create',
			vmName,
			`--project=${project}`,
			`--zone=${zone}`,
			`--machine-type=${machineType}`,
			`--image-family=${imageFamily}`,
			`--image-project=${imageProject}`,
			'--boot-disk-size=50GB',
			'--boot-disk-type=pd-standard',
			...(network ? [`--network=${network}`] : []),
			...(subnet ? [`--subnet=${subnet}`] : []),
			'--tags=iap-ssh',
			`--metadata=SPEC_SECRET_PATH=${spec.secret_path},SECRET_IMPERSONATE_SA=${env.SECRET_IMPERSONATE_SA || ''}`,
			'--labels=reindeer-env=true',
			'--scopes=cloud-platform',
			'--format=json',
		];

		if (vmServiceAccount) {
			createArgs.push(`--service-account=${vmServiceAccount}`);
		}

		console.log(`[env-orchestrator] Creating VM ${vmName} for environment ${envId}`);
		await gcloud(createArgs);
		console.log(`[env-orchestrator] VM ${vmName} created, waiting for SSH...`);

		const sshReady = await waitForSSH(vmName, zone, project);
		if (!sshReady) {
			throw new Error('Failed to establish SSH connection after multiple attempts');
		}

		console.log(`[env-orchestrator] SSH ready for ${vmName}, deploying startup script...`);

		const scriptContent = generateStartupScript();
		const tmpPath = join(tmpdir(), `env-startup-${envId}.sh`);
		writeFileSync(tmpPath, scriptContent, 'utf-8');

		try {
			await copyToVM(vmName, tmpPath, '/tmp/env-startup.sh', zone, project);

			const { exitCode } = await execOnVMStreaming(
				vmName,
				'chmod +x /tmp/env-startup.sh && sudo /tmp/env-startup.sh',
				(data, stream) => {
					console.log(`[env-orchestrator:${stream}] ${data}`);
				},
				zone,
				project,
				600000
			);

			if (exitCode !== 0) {
				throw new Error(`Startup script failed with exit code ${exitCode}`);
			}
		} finally {
			try {
				unlinkSync(tmpPath);
			} catch {
				// ignore cleanup errors
			}
		}

		const sshCommand = `gcloud compute ssh ${vmName} --zone=${zone} --project=${project} --tunnel-through-iap`;
		// Drop directly into the running devcontainer (where Claude/Codex/etc. live)
		const containerShellCommand = `gcloud compute ssh ${vmName} --zone=${zone} --project=${project} --tunnel-through-iap -- -t 'sudo devcontainer exec --workspace-folder /workspace bash -l'`;

		await updateEnvironmentConnectionInfo(envId, {
			ssh_command: sshCommand,
			container_shell_command: containerShellCommand,
			workspace_folder: '/workspace',
		});
		await updateEnvironmentStatus(envId, 'ready');

		console.log(`[env-orchestrator] Environment ${envId} is ready`);
	} catch (error) {
		console.error(`[env-orchestrator] Failed to provision environment ${envId}:`, error);
		await updateEnvironmentStatus(envId, 'failed');
		throw error;
	}
}

export async function stopEnvironment(envId: string): Promise<void> {
	const environment = await getEnvironmentById(envId);
	if (!environment) {
		throw new Error(`Environment ${envId} not found`);
	}

	if (!environment.vm_name || !environment.vm_zone) {
		throw new Error(`Environment ${envId} has no VM assigned`);
	}

	const project = env.GCP_PROJECT_ID;
	if (!project) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}

	console.log(`[env-orchestrator] Stopping VM ${environment.vm_name}`);

	await gcloud([
		'compute',
		'instances',
		'stop',
		environment.vm_name,
		`--zone=${environment.vm_zone}`,
		`--project=${project}`,
		'--quiet',
	]);

	await updateEnvironmentStatus(envId, 'stopped');
	console.log(`[env-orchestrator] Environment ${envId} stopped`);
}

export async function startEnvironment(envId: string): Promise<void> {
	const environment = await getEnvironmentById(envId);
	if (!environment) {
		throw new Error(`Environment ${envId} not found`);
	}

	if (!environment.vm_name || !environment.vm_zone) {
		throw new Error(`Environment ${envId} has no VM assigned`);
	}

	const project = env.GCP_PROJECT_ID;
	if (!project) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}

	await updateEnvironmentStatus(envId, 'provisioning');
	console.log(`[env-orchestrator] Starting VM ${environment.vm_name}`);

	await gcloud([
		'compute',
		'instances',
		'start',
		environment.vm_name,
		`--zone=${environment.vm_zone}`,
		`--project=${project}`,
		'--quiet',
	]);

	// Shorter waits since VM already has OS installed
	const sshReady = await waitForSSH(environment.vm_name, environment.vm_zone, project, {
		sleepMs: 15000,
		timeoutMs: 15000,
	});

	if (!sshReady) {
		await updateEnvironmentStatus(envId, 'failed');
		throw new Error('Failed to establish SSH after starting VM');
	}

	await updateEnvironmentStatus(envId, 'ready');
	console.log(`[env-orchestrator] Environment ${envId} restarted and ready`);
}

export async function deleteEnvironment(envId: string): Promise<void> {
	const environment = await getEnvironmentById(envId);
	if (!environment) {
		throw new Error(`Environment ${envId} not found`);
	}

	const project = env.GCP_PROJECT_ID;

	if (environment.vm_name && environment.vm_zone && project) {
		try {
			console.log(`[env-orchestrator] Deleting VM ${environment.vm_name}`);
			await gcloud([
				'compute',
				'instances',
				'delete',
				environment.vm_name,
				`--zone=${environment.vm_zone}`,
				`--project=${project}`,
				'--quiet',
			]);
		} catch (err) {
			console.warn(`[env-orchestrator] Failed to delete VM ${environment.vm_name}:`, err);
		}
	}

	await softDeleteEnvironment(envId);
	console.log(`[env-orchestrator] Environment ${envId} deleted`);
}
