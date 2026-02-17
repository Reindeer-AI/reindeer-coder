#!/usr/bin/env tsx

/**
 * Local development runner for reindeer-coder against PRODUCTION database
 * Uses Cloud SQL Connector with IAM auth (service account impersonation)
 *
 * Prerequisites:
 *   - gcloud auth login (with an account that can impersonate reindeer-coder SA)
 *   - gcloud auth application-default login
 *
 * Usage: npm run local:prod
 */

import { spawn } from 'node:child_process';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const GCP_PROJECT = 'reindeer-secrets';

// CloudSQL configuration
const CLOUDSQL_INSTANCE = 'reindeer-vibe:us-central1:reindeer-apps';
const DB_IAM_USER = 'reindeer-coder@reindeer-vibe.iam';
const DB_NAME = 'vibe_coding';

// Secrets to fetch from GCP Secret Manager
const SECRETS = {
	ANTHROPIC_API_KEY_SECRET: `projects/${GCP_PROJECT}/secrets/vibe-coding-anthropic-api-key/versions/latest`,
	OPENAI_API_KEY_SECRET: `projects/${GCP_PROJECT}/secrets/vibe-coding-openai-api-key/versions/latest`,
	GITLAB_TOKEN_SECRET: `projects/${GCP_PROJECT}/secrets/reindeer-gitlab-api-token/versions/latest`,
	LINEAR_API_KEY_SECRET: `projects/${GCP_PROJECT}/secrets/vibe-coding-linear-api-key/versions/latest`,
} as const;

// Static environment variables
const STATIC_ENV = {
	NODE_ENV: 'development',
	APP_URL: 'http://localhost:5173',

	// Auth0 Configuration
	AUTH0_DOMAIN: 'dev-0d0uyl2iqc17144b.us.auth0.com',
	AUTH0_AUDIENCE: 'https://vibe.reindeerlabs.ai',
	AUTH0_ORG_ID: 'org_9WU9bq88J0jAPjmM',

	// GCP Configuration
	GCP_PROJECT_ID: 'reindeer-vibe',
	GCP_ZONE: 'us-central1-a',
	GCP_NETWORK: 'default',
	GCP_VM_SERVICE_ACCOUNT: '527751278708-compute@developer.gserviceaccount.com',

	// VM Configuration
	VM_IMAGE_FAMILY: 'ubuntu-2204-lts',
	VM_IMAGE_PROJECT: 'ubuntu-os-cloud',
	VM_MACHINE_TYPE: 'e2-standard-4',
	VM_USER: 'reindeer-vibe',

	// Git Configuration (GitLab)
	GIT_BASE_URL: 'https://gitlab.com',
	GIT_ORG: 'reindeerai',
	GIT_USER: 'oauth2',
	GITLAB_API_URL: 'https://gitlab.com/api/v4',
	EMAIL_DOMAIN: 'reindeer.ai',

	// Task monitoring
	TASK_MONITOR_POLL_INTERVAL_MS: '60000',
	LINEAR_POLL_INTERVAL_MS: '60000',
} as const;

async function fetchSecrets(): Promise<Record<string, string>> {
	const client = new SecretManagerServiceClient();
	const secrets: Record<string, string> = {};

	console.log('Fetching secrets from GCP Secret Manager...');

	for (const [envVar, secretPath] of Object.entries(SECRETS)) {
		try {
			const [version] = await client.accessSecretVersion({ name: secretPath });
			const value = version.payload?.data?.toString();
			if (value) {
				secrets[envVar] = value;
				console.log(`  ✓ ${envVar}`);
			} else {
				console.warn(`  ✗ ${envVar} (empty)`);
			}
		} catch (error) {
			console.warn(
				`  ✗ ${envVar} (failed to fetch: ${error instanceof Error ? error.message : 'unknown error'})`
			);
		}
	}

	return secrets;
}

async function main() {
	console.log('🦌 Starting reindeer-coder local development server (PRODUCTION DB)\n');
	console.log('⚠️  WARNING: Connected to PRODUCTION database. Be careful with write operations.\n');

	// Fetch secrets from GCP
	const secrets = await fetchSecrets();

	// Build database URL for IAM auth (Cloud SQL Connector handles connectivity)
	const databaseUrl = `postgresql://${encodeURIComponent(DB_IAM_USER)}@localhost/${DB_NAME}`;
	console.log(`\nDatabase URL: ${databaseUrl}`);
	console.log(`CloudSQL Instance: ${CLOUDSQL_INSTANCE}\n`);

	// Combine all environment variables
	const env = {
		...process.env,
		...STATIC_ENV,
		...secrets,
		// Database connection (Cloud SQL Connector will use these)
		DB_TYPE: 'postgres',
		DATABASE_URL: databaseUrl,
		CLOUDSQL_INSTANCE: CLOUDSQL_INSTANCE,
		// Impersonation for Cloud SQL Connector and Secret Manager
		GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: 'reindeer-coder@reindeer-vibe.iam.gserviceaccount.com',
	};

	console.log('Starting vite dev server...\n');

	// Start vite dev server
	const vite = spawn('npm', ['run', 'dev'], {
		cwd: process.cwd(),
		env,
		stdio: 'inherit',
	});

	vite.on('error', (error) => {
		console.error('Failed to start dev server:', error);
		process.exit(1);
	});

	vite.on('exit', (code) => {
		process.exit(code ?? 0);
	});

	// Handle signals
	const cleanup = () => {
		console.log('\nShutting down...');
		vite.kill('SIGTERM');
	};

	process.on('SIGINT', cleanup);
	process.on('SIGTERM', cleanup);
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
