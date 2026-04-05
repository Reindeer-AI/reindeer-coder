import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { createEnvironment, getEnvironmentsByUserId, getSpecById } from '$lib/server/db';
import { provisionEnvironment } from '$lib/server/vm/env-orchestrator';
import type { RequestHandler } from './$types';

// GET /api/environments - List all environments for the authenticated user
export const GET: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const environments = await getEnvironmentsByUserId(user.sub);
	return json({ environments });
};

// POST /api/environments - Create a new environment
export const POST: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	let body: { spec_id?: string; name?: string; machine_type?: string };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	if (!body.spec_id) {
		throw error(400, 'Missing required field: spec_id');
	}

	// Verify spec exists and belongs to user
	const spec = await getSpecById(body.spec_id);
	if (!spec) {
		throw error(404, 'Spec not found');
	}

	if (spec.user_id !== user.sub) {
		throw error(403, 'Access denied to spec');
	}

	const userEmail = user.email || 'unknown';
	const environment = await createEnvironment(
		user.sub,
		userEmail,
		{
			spec_id: body.spec_id,
			name: body.name,
			machine_type: body.machine_type,
		},
		spec.name
	);

	// Fire and forget provisioning (same pattern as startTask)
	provisionEnvironment(environment.id).catch((err) => {
		console.error(`Failed to provision environment ${environment.id}:`, err);
	});

	return json({ environment }, { status: 201 });
};
