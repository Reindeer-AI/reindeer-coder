import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { getEnvironmentById } from '$lib/server/db';
import { deleteEnvironment } from '$lib/server/vm/env-orchestrator';
import type { RequestHandler } from './$types';

// GET /api/environments/:id - Get environment details
export const GET: RequestHandler = async ({ params, request }) => {
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

	return json({ environment });
};

// DELETE /api/environments/:id - Delete environment (destroy VM)
export const DELETE: RequestHandler = async ({ params, request }) => {
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

	try {
		await deleteEnvironment(params.id);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		console.error(`[api/environments] Failed to delete environment ${params.id}:`, err);
		throw error(500, msg);
	}

	return json({ success: true });
};
