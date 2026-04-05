import { error, json } from '@sveltejs/kit';
import { v4 as uuidv4 } from 'uuid';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { createSpec, getSpecsByUserId } from '$lib/server/db';
import { createSpecSecret } from '$lib/server/specs/spec-store';
import type { RequestHandler } from './$types';

// GET /api/specs - List all specs for the authenticated user
export const GET: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const specs = await getSpecsByUserId(user.sub);
	return json({ specs });
};

// POST /api/specs - Create a new spec
export const POST: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	let body: { name?: string; devcontainer_json?: string };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	if (!body.name || !body.devcontainer_json) {
		throw error(400, 'Missing required fields: name, devcontainer_json');
	}

	// Validate that devcontainer_json is valid JSON
	try {
		JSON.parse(body.devcontainer_json);
	} catch {
		throw error(400, 'devcontainer_json must be valid JSON');
	}

	const specId = uuidv4();

	// Store content in Secret Manager
	let secretPath: string;
	try {
		secretPath = await createSpecSecret(specId, body.devcontainer_json);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown error';
		console.error('[api/specs] Failed to create secret:', err);
		throw error(500, `Failed to store spec in Secret Manager: ${msg}`);
	}

	// Create DB record with the secret path
	const spec = await createSpec(user.sub, body.name, secretPath);

	return json({ spec }, { status: 201 });
};
