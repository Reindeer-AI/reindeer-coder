import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { env } from '$env/dynamic/private';

// Reuse the same lazy-init pattern from secrets.ts
let client: SecretManagerServiceClient | null = null;

function getClient(): SecretManagerServiceClient {
	if (!client) {
		client = new SecretManagerServiceClient();
	}
	return client;
}

const cache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getProjectId(): string {
	const project = env.GCP_PROJECT_ID;
	if (!project) {
		throw new Error('GCP_PROJECT_ID environment variable is required');
	}
	return project;
}

/**
 * Create a new secret in Secret Manager and store devcontainer.json as its first version.
 * Returns the secret_path (projects/P/secrets/spec-UUID/versions/latest).
 */
export async function createSpecSecret(specId: string, devcontainerJson: string): Promise<string> {
	const project = getProjectId();
	const secretId = `spec-${specId}`;
	const parent = `projects/${project}`;
	const name = `${parent}/secrets/${secretId}`;

	// Create the secret resource
	await getClient().createSecret({
		parent,
		secretId,
		secret: { replication: { automatic: {} } },
	});

	// Add the first version with the devcontainer.json content
	await getClient().addSecretVersion({
		parent: name,
		payload: { data: Buffer.from(devcontainerJson, 'utf-8') },
	});

	return `${name}/versions/latest`;
}

/**
 * Update spec content by adding a new version to the existing secret.
 */
export async function updateSpecSecret(
	secretPath: string,
	devcontainerJson: string
): Promise<void> {
	// secretPath = projects/P/secrets/spec-UUID/versions/latest
	// parent for addSecretVersion = projects/P/secrets/spec-UUID
	const parent = secretPath.replace(/\/versions\/.*$/, '');

	await getClient().addSecretVersion({
		parent,
		payload: { data: Buffer.from(devcontainerJson, 'utf-8') },
	});
}

/**
 * Read spec content (devcontainer.json) from Secret Manager.
 */
export async function readSpecSecret(secretPath: string): Promise<string> {
	const cached = cache.get(secretPath);
	if (cached && Date.now() < cached.expiresAt) {
		return cached.value;
	}

	const [version] = await getClient().accessSecretVersion({ name: secretPath });
	const value = version.payload?.data?.toString() || '';
	cache.set(secretPath, { value, expiresAt: Date.now() + CACHE_TTL_MS });
	return value;
}

/**
 * Delete a spec secret from Secret Manager.
 */
export async function deleteSpecSecret(secretPath: string): Promise<void> {
	const name = secretPath.replace(/\/versions\/.*$/, '');
	await getClient().deleteSecret({ name });
}
