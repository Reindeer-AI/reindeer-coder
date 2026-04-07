import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { getEnvironmentById } from '$lib/server/db';
import { startEnvironment } from '$lib/server/vm/env-orchestrator';
import type { RequestHandler } from './$types';

// POST /api/environments/:id/start - Start a stopped environment
export const POST: RequestHandler = async ({ params, request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const environment = await getEnvironmentById(params.id);
	if (!environment) {
		throw error(404, 'Environment not found');
	}

	if (environment.user_id !== user.sub) {
		throw error(403, 'Access denied');
	}

	if (environment.status !== 'stopped') {
		throw error(
			400,
			`Cannot start environment with status '${environment.status}'. Must be 'stopped'.`
		);
	}

	// Fire and forget (same pattern as provisioning)
	startEnvironment(params.id).catch((err) => {
		console.error(`Failed to start environment ${params.id}:`, err);
	});

	return json({ success: true });
};
