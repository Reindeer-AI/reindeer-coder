import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { configService } from '../config-service';
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

META() {
  curl -sf "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" \\
    -H "Metadata-Flavor: Google" || true
}

echo "[env] Fetching devcontainer spec from Secret Manager..."
SPEC_SECRET=$(META SPEC_SECRET_PATH)
SA=$(META SECRET_IMPERSONATE_SA)
IMPERSONATE=""
[ -n "$SA" ] && IMPERSONATE="--impersonate-service-account=$SA"

mkdir -p /workspace/.devcontainer
gcloud secrets versions access "$SPEC_SECRET" $IMPERSONATE \\
  > /workspace/.devcontainer/devcontainer.json

echo "[env] Installing Docker + dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io curl git jq openssl
systemctl enable --now docker

echo "[env] Installing Node.js + devcontainer CLI..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs
npm install -g @devcontainers/cli

STARTER_REPOS_B64=$(META STARTER_REPOS_B64)
STARTER_REPOS_PATH_B64=$(META STARTER_REPOS_PATH_B64)
STARTER_REPOS=""
STARTER_REPOS_PATH=""
[ -n "$STARTER_REPOS_B64" ] && STARTER_REPOS=$(echo "$STARTER_REPOS_B64" | base64 -d)
[ -n "$STARTER_REPOS_PATH_B64" ] && STARTER_REPOS_PATH=$(echo "$STARTER_REPOS_PATH_B64" | base64 -d)

if [ -n "$STARTER_REPOS" ] && [ -n "$STARTER_REPOS_PATH" ]; then
  echo "[env] Resolving GitHub App installation token for starter repos..."
  GITHUB_APP_ID=$(META GITHUB_APP_ID)
  GITHUB_INSTALLATION_ID=$(META GITHUB_INSTALLATION_ID)
  GITHUB_APP_PRIVATE_KEY_SECRET=$(META GITHUB_APP_PRIVATE_KEY_SECRET)
  GH_TOKEN=""

  # Validate GITHUB_APP_ID is numeric to prevent JSON injection in JWT payload
  if ! [[ "$GITHUB_APP_ID" =~ ^[0-9]+$ ]]; then
    GITHUB_APP_ID=""
  fi

  if [ -n "$GITHUB_APP_ID" ] && [ -n "$GITHUB_INSTALLATION_ID" ] && [ -n "$GITHUB_APP_PRIVATE_KEY_SECRET" ]; then
    PRIVATE_KEY=""
    if ! PRIVATE_KEY=$(gcloud secrets versions access "$GITHUB_APP_PRIVATE_KEY_SECRET" $IMPERSONATE 2>/tmp/gcloud-err.log); then
      echo "[env] ERROR: failed to read GitHub App private key from Secret Manager:"
      cat /tmp/gcloud-err.log
      rm -f /tmp/gcloud-err.log
      exit 1
    fi
    rm -f /tmp/gcloud-err.log

    if [ -n "$PRIVATE_KEY" ]; then
      # Restrictive umask so the PEM file is never world-readable, even briefly
      ( umask 077 && printf '%s' "$PRIVATE_KEY" > /tmp/gh-app.pem )
      NOW=$(date +%s)
      IAT=$((NOW - 60))
      EXP=$((NOW + 600))
      HEADER=$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | base64 -w 0 | tr '+/' '-_' | tr -d '=')
      # GITHUB_APP_ID is validated as numeric above; safe to interpolate
      PAYLOAD=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$IAT" "$EXP" "$GITHUB_APP_ID" | base64 -w 0 | tr '+/' '-_' | tr -d '=')
      SIGNATURE=$(printf '%s' "$HEADER.$PAYLOAD" | openssl dgst -sha256 -sign /tmp/gh-app.pem | base64 -w 0 | tr '+/' '-_' | tr -d '=')
      JWT="$HEADER.$PAYLOAD.$SIGNATURE"
      GH_TOKEN=$(curl -sf -X POST \\
        -H "Authorization: Bearer $JWT" \\
        -H "Accept: application/vnd.github+json" \\
        "https://api.github.com/app/installations/$GITHUB_INSTALLATION_ID/access_tokens" | jq -r '.token // empty')
      rm -f /tmp/gh-app.pem
    fi
  fi

  if [ -n "$GH_TOKEN" ]; then
    echo "[env] Cloning starter repos to $STARTER_REPOS_PATH..."
    mkdir -p "$STARTER_REPOS_PATH"
    # Build Authorization header value: base64('x-access-token:<token>')
    # Token is passed via -c http.extraheader (never on the command line, never in URLs)
    AUTH_B64=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w 0)
    AUTH_HEADER="Authorization: Basic $AUTH_B64"
    pids=()
    for repo in $(echo "$STARTER_REPOS" | tr ',' ' '); do
      name=$(basename "$repo")
      target="$STARTER_REPOS_PATH/$name"
      # Check for .git, not just dir presence — partial clones leave a dir but no .git
      if [ -d "$target/.git" ]; then
        echo "[env] Skipping $repo (already cloned)"
        continue
      fi
      # Remove any leftover partial directory
      rm -rf "$target"
      (
        # Capture stderr separately so we can scrub any leaked tokens before logging
        if git -c http.extraheader="$AUTH_HEADER" clone --quiet \\
            "https://github.com/$repo.git" "$target" 2>/tmp/clone-$$.err; then
          rm -f /tmp/clone-$$.err
        else
          # Defense-in-depth: scrub anything that looks like a token before echoing
          sed -E 's/(gh[opsu]_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,})/[REDACTED]/g; s/x-access-token:[^@[:space:]]+/x-access-token:[REDACTED]/g' /tmp/clone-$$.err >&2
          rm -f /tmp/clone-$$.err
          exit 1
        fi
      ) &
      pids+=($!)
    done
    for pid in "\${pids[@]}"; do wait "$pid" || echo "[env] WARNING: clone failed (pid $pid)"; done

    # Lock down ownership: only the typical container user (uid/gid 1000) can read/write.
    # The VM is single-tenant per environment, but we still avoid world-writable to prevent
    # any cross-process leakage and to protect against in-container malicious code being
    # able to modify these repos via host-side processes.
    chown -R 1000:1000 "$STARTER_REPOS_PATH"
    chmod -R u=rwX,g=rwX,o= "$STARTER_REPOS_PATH"

    GH_TOKEN=""
    AUTH_HEADER=""
    AUTH_B64=""
    echo "[env] Starter repos ready"
  else
    echo "[env] Skipping starter repos: GitHub App not configured or token mint failed"
  fi
fi

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

	const starterReposRaw = await configService.get('vm.starter_repos', '');
	const starterReposPathRaw = await configService.get('vm.starter_repos_path', '/opt/repos');

	// Validate starter_repos format: comma-separated "org/repo" entries.
	// Reject anything that could break shell parsing or smuggle metadata.
	const starterRepos = starterReposRaw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s));
	if (starterRepos.length !== starterReposRaw.split(',').filter((s) => s.trim()).length) {
		console.warn(
			`[env-orchestrator] vm.starter_repos contains invalid entries; valid entries: ${starterRepos.join(',')}`
		);
	}

	// Validate starter_repos_path: absolute POSIX path, no shell metacharacters
	const starterReposPath = /^\/[A-Za-z0-9_./-]+$/.test(starterReposPathRaw)
		? starterReposPathRaw
		: '/opt/repos';
	if (starterReposPath !== starterReposPathRaw) {
		console.warn(
			`[env-orchestrator] vm.starter_repos_path "${starterReposPathRaw}" is invalid; using default "${starterReposPath}"`
		);
	}

	// Both values flow through GCE metadata; encode them to defeat any injection
	// via commas or special characters in the --metadata flag.
	const starterReposB64 = Buffer.from(starterRepos.join(','), 'utf-8').toString('base64');
	const starterReposPathB64 = Buffer.from(starterReposPath, 'utf-8').toString('base64');

	await updateEnvironmentVm(envId, vmName, zone, machineType);
	await updateEnvironmentStatus(envId, 'provisioning');

	try {
		// VM metadata is capped at 256 KB total per value; safe for these short scalars
		// and a base64'd repo list. Don't dump JSON manifests through this channel.
		const metadata = [
			`SPEC_SECRET_PATH=${spec.secret_path}`,
			`SECRET_IMPERSONATE_SA=${env.SECRET_IMPERSONATE_SA || ''}`,
			`GITHUB_APP_ID=${env.GITHUB_APP_ID || ''}`,
			`GITHUB_INSTALLATION_ID=${env.GITHUB_INSTALLATION_ID || ''}`,
			`GITHUB_APP_PRIVATE_KEY_SECRET=${env.GITHUB_APP_PRIVATE_KEY_SECRET || ''}`,
			`STARTER_REPOS_B64=${starterReposB64}`,
			`STARTER_REPOS_PATH_B64=${starterReposPathB64}`,
		].join(',');

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
			`--metadata=${metadata}`,
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
