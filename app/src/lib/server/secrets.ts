import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { env } from '$env/dynamic/private';
import { configService } from './config-service';

// Lazy-initialized client to avoid errors when GCP credentials aren't available
let client: SecretManagerServiceClient | null = null;
const cache = new Map<string, { value: string; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get the Secret Manager client, initializing lazily on first use.
 */
function getClient(): SecretManagerServiceClient {
	if (!client) {
		client = new SecretManagerServiceClient();
	}
	return client;
}

/**
 * Resolve a secret from Google Cloud Secret Manager at runtime.
 * Uses caching to minimize API calls.
 *
 * @param secretPath - The full secret path (e.g., "projects/123/secrets/my-secret/versions/latest")
 * @returns The secret value as a string
 */
export async function getSecret(secretPath: string): Promise<string> {
	// Check cache first
	const cached = cache.get(secretPath);
	if (cached && Date.now() < cached.expiresAt) {
		return cached.value;
	}

	// Resolve from Secret Manager
	const [version] = await getClient().accessSecretVersion({ name: secretPath });
	const value = version.payload?.data?.toString() || '';

	// Cache the result
	cache.set(secretPath, { value, expiresAt: Date.now() + CACHE_TTL_MS });

	return value;
}

/**
 * Clear the secret cache (useful for testing or forcing refresh)
 */
export function clearSecretCache(): void {
	cache.clear();
}

/**
 * Get the Anthropic API key from Secret Manager.
 * Priority: 1. DB config, 2. Env var secret path, 3. Direct env var (legacy)
 */
export async function getAnthropicApiKey(): Promise<string> {
	// 1. Check config service for secret path
	const configPath = await configService.get('secrets.anthropic_api_key');
	if (configPath) {
		return getSecret(configPath);
	}

	// 2. Try secret path from env var
	const secretPath = env.ANTHROPIC_API_KEY_SECRET;
	if (secretPath) {
		return getSecret(secretPath);
	}

	// 3. Fallback to direct env var (backwards compatibility)
	const directKey = env.ANTHROPIC_API_KEY;
	if (directKey) {
		console.warn(
			'[secrets] Using ANTHROPIC_API_KEY directly - consider migrating to secrets.anthropic_api_key config'
		);
		return directKey;
	}

	throw new Error(
		'No Anthropic API key configured - set secrets.anthropic_api_key in config or ANTHROPIC_API_KEY_SECRET env var'
	);
}

/**
 * Get the OpenAI API key from Secret Manager.
 * Priority: 1. DB config, 2. Env var secret path, 3. Direct env var (legacy)
 */
export async function getOpenAiApiKey(): Promise<string> {
	// 1. Check config service for secret path
	const configPath = await configService.get('secrets.openai_api_key');
	if (configPath) {
		return getSecret(configPath);
	}

	// 2. Try secret path from env var
	const secretPath = env.OPENAI_API_KEY_SECRET;
	if (secretPath) {
		return getSecret(secretPath);
	}

	// 3. Fallback to direct env var (backwards compatibility)
	const directKey = env.OPENAI_API_KEY;
	if (directKey) {
		console.warn(
			'[secrets] Using OPENAI_API_KEY directly - consider migrating to secrets.openai_api_key config'
		);
		return directKey;
	}

	throw new Error(
		'No OpenAI API key configured - set secrets.openai_api_key in config or OPENAI_API_KEY_SECRET env var'
	);
}

/**
 * Get the GitLab token from Secret Manager.
 * Priority: 1. DB config, 2. Env var secret path, 3. Direct env var (legacy)
 */
export async function getGitLabToken(): Promise<string> {
	// 1. Check config service for secret path
	const configPath = await configService.get('secrets.gitlab_token');
	if (configPath) {
		return getSecret(configPath);
	}

	// 2. Try secret path from env var
	const secretPath = env.GITLAB_TOKEN_SECRET;
	if (secretPath) {
		return getSecret(secretPath);
	}

	// 3. Fallback to direct env var (backwards compatibility)
	const directToken = env.GITLAB_TOKEN;
	if (directToken) {
		console.warn(
			'[secrets] Using GITLAB_TOKEN directly - consider migrating to secrets.gitlab_token config'
		);
		return directToken;
	}

	throw new Error(
		'No GitLab token configured - set secrets.gitlab_token in config or GITLAB_TOKEN_SECRET env var'
	);
}

/**
 * Get the Linear API key from Secret Manager.
 * Priority: 1. DB config, 2. Env var secret path, 3. Direct env var (legacy)
 */
export async function getLinearApiKey(): Promise<string> {
	// 1. Check config service for secret path
	const configPath = await configService.get('secrets.linear_api_key');
	if (configPath) {
		return getSecret(configPath);
	}

	// 2. Try secret path from env var
	const secretPath = env.LINEAR_API_KEY_SECRET;
	if (secretPath) {
		return getSecret(secretPath);
	}

	// 3. Fallback to direct env var (backwards compatibility)
	const directKey = env.LINEAR_API_KEY;
	if (directKey) {
		console.warn(
			'[secrets] Using LINEAR_API_KEY directly - consider migrating to secrets.linear_api_key config'
		);
		return directKey;
	}

	throw new Error(
		'No Linear API key configured - set secrets.linear_api_key in config or LINEAR_API_KEY_SECRET env var'
	);
}
