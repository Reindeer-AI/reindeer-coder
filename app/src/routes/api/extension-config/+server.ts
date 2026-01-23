import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { configService } from '$lib/server/config-service';
import type { RequestHandler } from './$types';

/**
 * GET /api/extension-config
 * Public endpoint (no auth required) that returns configuration for the VSCode extension
 * This allows the extension to bootstrap itself with just a server URL
 */
export const GET: RequestHandler = async ({ url }) => {
	// Get configuration from environment and config service
	// Check both VITE_ prefixed (build-time) and non-prefixed (runtime) env vars
	const auth0Domain = env.VITE_AUTH0_DOMAIN || env.AUTH0_DOMAIN || '';
	const auth0ClientId = env.VITE_AUTH0_CLIENT_ID || env.AUTH0_CLIENT_ID || '';
	const auth0Audience = env.VITE_AUTH0_AUDIENCE || env.AUTH0_AUDIENCE || '';
	const auth0OrganizationId = env.VITE_AUTH0_ORG_ID || env.AUTH0_ORG_ID || '';

	const gcpProject = env.GCP_PROJECT_ID || env.VITE_GCP_PROJECT_ID || '';
	const vmUser = await configService.get('vm.user', env.VM_USER || 'agent');

	// Build web URL from request or env
	const appUrl = env.APP_URL || `${url.protocol}//${url.host}`;

	// Get default system prompt from config
	const defaultSystemPrompt = await configService.get(
		'agent.default_system_prompt',
		`You are a software engineer. Follow these guidelines:

1. Write clean, well-documented code following the project's existing patterns and conventions
2. When making code changes, create a new feature branch from the base branch
3. After completing the task, create a detailed merge request that includes:
   - A clear title describing the change
   - A summary of what was changed and why
   - Testing steps or verification instructions
4. Commit messages should be descriptive and follow conventional commit format
5. Work autonomously - make reasonable decisions without asking for confirmation
6. If you encounter minor blockers, try alternative approaches before escalating`
	);

	return json({
		auth0: {
			domain: auth0Domain,
			clientId: auth0ClientId,
			audience: auth0Audience,
			organizationId: auth0OrganizationId || undefined,
		},
		gcp: {
			project: gcpProject,
		},
		vm: {
			user: vmUser,
		},
		app: {
			url: appUrl,
		},
		agent: {
			defaultSystemPrompt,
		},
	});
};
