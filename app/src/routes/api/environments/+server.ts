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

	let body: {
		spec_id?: string;
		name?: string;
		description?: string;
		machine_type?: string;
		zone?: string;
	};
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	if (!body.spec_id) {
		throw error(400, 'Missing required field: spec_id');
	}

	const trimmedDescription = body.description?.trim();
	if (trimmedDescription && trimmedDescription.length > 500) {
		throw error(400, 'Description must be 500 characters or fewer');
	}

	// Strict GCE zone format: prevents injection into the --zone flag.
	// Matches e.g. us-central1-a, europe-west1-b, asia-northeast1-c.
	if (body.zone && !/^[a-z]+-[a-z]+[0-9]+-[a-z]$/.test(body.zone)) {
		throw error(400, 'Invalid zone format. Expected e.g. "us-central1-a", "europe-west1-b".');
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
			description: trimmedDescription || undefined,
			machine_type: body.machine_type,
			zone: body.zone,
		},
		spec.name
	);

	// Fire and forget provisioning (same pattern as startTask)
	provisionEnvironment(environment.id).catch((err) => {
		console.error(`Failed to provision environment ${environment.id}:`, err);
	});

	return json({ environment }, { status: 201 });
};
