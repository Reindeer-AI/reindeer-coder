import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { getEnvironmentById } from '$lib/server/db';
import { stopEnvironment } from '$lib/server/vm/env-orchestrator';
import type { RequestHandler } from './$types';

// POST /api/environments/:id/stop - Stop a running environment
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

	if (environment.status !== 'ready') {
		throw error(
			400,
			`Cannot stop environment with status '${environment.status}'. Must be 'ready'.`
		);
	}

	try {
		await stopEnvironment(params.id);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		console.error(`[api/environments] Failed to stop environment ${params.id}:`, err);
		throw error(500, msg);
	}

	return json({ success: true });
};
