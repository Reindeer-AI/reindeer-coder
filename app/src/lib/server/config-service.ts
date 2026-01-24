import { env } from '$env/dynamic/private';
import { setConfig as dbSetConfig, getAllConfig, getConfigByKey } from './db';
import type { Config } from './db/schema';

/**
 * Configuration service with caching
 * Provides centralized configuration management for the application
 */
class ConfigService {
	private cache: Map<string, string> = new Map();
	private loaded: boolean = false;
	private loading: Promise<void> | null = null;

	/**
	 * Load all configuration from database into cache
	 */
	private async loadConfig(): Promise<void> {
		if (this.loaded) return;
		if (this.loading) return this.loading;

		this.loading = (async () => {
			try {
				const configs = await getAllConfig();
				for (const config of configs) {
					this.cache.set(config.key, config.value);
				}
				this.loaded = true;
				console.log(`[ConfigService] Loaded ${configs.length} configuration values`);
			} catch (error) {
				console.error('[ConfigService] Failed to load configuration:', error);
				// Don't set loaded=true on failure so we can retry
			} finally {
				this.loading = null;
			}
		})();

		return this.loading;
	}

	/**
	 * Get a configuration value
	 * Priority: 1. Database config, 2. Environment variable, 3. Default value
	 *
	 * @param key - Configuration key (use dot notation for nested keys, e.g., "ui.brand_name")
	 * @param defaultValue - Default value if not found in DB or env
	 * @param envKey - Optional environment variable name (if different from key)
	 */
	async get(key: string, defaultValue: string = '', envKey?: string): Promise<string> {
		// Ensure config is loaded
		await this.loadConfig();

		// 1. Check database config (highest priority)
		const cachedValue = this.cache.get(key);
		if (cachedValue !== undefined) {
			return cachedValue;
		}

		// 2. Check environment variable (fallback)
		const envValue = env[envKey || key.toUpperCase().replace(/\./g, '_')];
		if (envValue) {
			return envValue;
		}

		// 3. Return default value (lowest priority)
		return defaultValue;
	}

	/**
	 * Get a configuration value synchronously (uses cached values only)
	 * Use this for performance-critical paths after config has been loaded
	 */
	getSync(key: string, defaultValue: string = '', envKey?: string): string {
		// 1. Check database config cache
		const cachedValue = this.cache.get(key);
		if (cachedValue !== undefined) {
			return cachedValue;
		}

		// 2. Check environment variable
		const envValue = env[envKey || key.toUpperCase().replace(/\./g, '_')];
		if (envValue) {
			return envValue;
		}

		// 3. Return default value
		return defaultValue;
	}

	/**
	 * Set a configuration value in the database and update cache
	 */
	async set(
		key: string,
		value: string,
		description?: string,
		isSecret?: boolean,
		category?: string
	): Promise<void> {
		await dbSetConfig({ key, value, description, is_secret: isSecret, category });
		this.cache.set(key, value);
		console.log(`[ConfigService] Updated config: ${key}`);
	}

	/**
	 * Reload configuration from database
	 */
	async reload(): Promise<void> {
		this.loaded = false;
		this.cache.clear();
		await this.loadConfig();
	}

	/**
	 * Get all configuration (with secrets masked for display)
	 */
	async getAllForDisplay(): Promise<Array<Config & { value: string }>> {
		const configs = await getAllConfig();
		return configs.map((config) => ({
			...config,
			// Mask secret values for display
			value: config.is_secret ? '[REDACTED]' : config.value,
		}));
	}
}

// Export singleton instance
export const configService = new ConfigService();

/**
 * Default configuration values
 * These define the initial configuration structure for the application
 */
export const DEFAULT_CONFIG = {
	// UI Configuration
	'ui.brand_name': {
		value: 'Code Agent',
		description: 'Application brand name shown in the UI',
		category: 'UI',
		is_secret: false,
	},
	'ui.logo_path': {
		value: '/logo.png',
		description: 'Path to the application logo',
		category: 'UI',
		is_secret: false,
	},
	'ui.primary_color': {
		value: '#2563eb',
		description: 'Primary brand color (hex)',
		category: 'UI',
		is_secret: false,
	},
	'ui.primary_color_dark': {
		value: '#1e40af',
		description: 'Dark variant of primary brand color',
		category: 'UI',
		is_secret: false,
	},
	'ui.primary_color_light': {
		value: '#3b82f6',
		description: 'Light variant of primary brand color',
		category: 'UI',
		is_secret: false,
	},
	'ui.background_color': {
		value: '#f9fafb',
		description: 'Background color (hex)',
		category: 'UI',
		is_secret: false,
	},

	// Git Configuration
	'git.provider': {
		value: 'gitlab',
		description: 'Git provider (github or gitlab)',
		category: 'Git',
		is_secret: false,
	},
	'git.base_url': {
		value: 'https://gitlab.com',
		description: 'Git repository base URL (e.g., https://github.com or https://gitlab.com)',
		category: 'Git',
		is_secret: false,
	},
	'git.org': {
		value: 'your-org',
		description: 'Git organization/group name',
		category: 'Git',
		is_secret: false,
	},
	'git.user': {
		value: 'oauth2',
		description: 'Git user for authentication (oauth2 for GitLab, x-access-token for GitHub)',
		category: 'Git',
		is_secret: false,
	},
	'git.default_base_branch': {
		value: 'main',
		description: 'Default base branch for new tasks',
		category: 'Git',
		is_secret: false,
	},
	'git.branch_prefix': {
		value: 'agent',
		description: 'Prefix for generated branch names',
		category: 'Git',
		is_secret: false,
	},

	// VM Configuration
	'vm.user': {
		value: 'agent',
		description: 'VM user account name',
		category: 'VM',
		is_secret: false,
	},
	'vm.machine_type': {
		value: 'e2-standard-4',
		description: 'GCP VM machine type',
		category: 'VM',
		is_secret: false,
	},
	'vm.image_family': {
		value: 'ubuntu-2204-lts',
		description: 'VM image family',
		category: 'VM',
		is_secret: false,
	},
	'vm.image_project': {
		value: 'ubuntu-os-cloud',
		description: 'VM image project',
		category: 'VM',
		is_secret: false,
	},

	// Agent Configuration
	'agent.default_cli': {
		value: 'claude-code',
		description: 'Default coding CLI (claude-code, gemini, codex)',
		category: 'Agent',
		is_secret: false,
	},
	'agent.default_system_prompt': {
		value: `IMPORTANT INSTRUCTIONS:
1. If the task description already contains an implementation plan, do NOT plan again. Use the existing plan and proceed directly to implementation.
2. If you need to create a plan, do NOT ask the user to approve it. Create the plan and immediately begin implementation.
3. Make best-effort decisions independently. Only ask for human input if absolutely critical (e.g., security implications, data loss risk, or when multiple approaches have significant trade-offs).
4. When you complete the implementation, ALWAYS create a merge request with your changes. Do not wait for the user to request this.
5. Be autonomous and proactive in your implementation approach.
6. If you are building a web application (node / Svelte), run the server locally in development mode. There should be a background task with the web server running on http://localhost:5173
7. Environment setup: If there's a .env.example file, create .env from it (cp .env.example .env) and ask the user if any additional environment variables need to be configured`,
		description: 'Default system prompt for agents',
		category: 'Agent',
		is_secret: false,
	},

	// Authentication Configuration
	'auth.admin_permission': {
		value: 'admin',
		description: 'Permission string for admin users',
		category: 'Authentication',
		is_secret: false,
	},

	// Email Configuration
	'email.domain': {
		value: 'example.com',
		description: 'Email domain for generated email addresses',
		category: 'Email',
		is_secret: false,
	},
	'email.fallback_address': {
		value: 'agent@example.com',
		description: 'Fallback email address for automated actions',
		category: 'Email',
		is_secret: false,
	},

	// Secrets Configuration (paths to Secret Manager secrets)
	'secrets.anthropic_api_key': {
		value: '',
		description:
			'Secret Manager path for Anthropic API key (e.g., projects/123/secrets/name/versions/latest)',
		category: 'Secrets',
		is_secret: false,
	},
	'secrets.openai_api_key': {
		value: '',
		description: 'Secret Manager path for OpenAI API key',
		category: 'Secrets',
		is_secret: false,
	},
	'secrets.gitlab_token': {
		value: '',
		description: 'Secret Manager path for GitLab token',
		category: 'Secrets',
		is_secret: false,
	},
	'secrets.github_app_private_key': {
		value: '',
		description: 'Secret Manager path for GitHub App private key (PEM format)',
		category: 'Secrets',
		is_secret: false,
	},
	'secrets.linear_api_key': {
		value: '',
		description: 'Secret Manager path for Linear API key',
		category: 'Secrets',
		is_secret: false,
	},

	// GitHub App Configuration
	'github.app_id': {
		value: '',
		description: 'GitHub App ID',
		category: 'Git',
		is_secret: false,
	},
	'github.installation_id': {
		value: '',
		description: 'GitHub App Installation ID',
		category: 'Git',
		is_secret: false,
	},
};

/**
 * Initialize default configuration in the database
 * This should be called once during application startup
 */
export async function initializeDefaultConfig(): Promise<void> {
	console.log('[ConfigService] Initializing default configuration...');

	try {
		for (const [key, config] of Object.entries(DEFAULT_CONFIG)) {
			try {
				// Check if config already exists
				const existing = await getConfigByKey(key);
				if (!existing) {
					// Only set if it doesn't exist (don't overwrite user changes)
					await dbSetConfig({
						key,
						value: config.value,
						description: config.description,
						is_secret: config.is_secret,
						category: config.category,
					});
					console.log(`[ConfigService] Initialized config: ${key}`);
				}
			} catch (error) {
				console.error(`[ConfigService] Failed to initialize config ${key}:`, error);
			}
		}

		console.log('[ConfigService] Default configuration initialized');
	} catch (error) {
		console.error('[ConfigService] Failed to initialize default configuration:', error);
	}
}
