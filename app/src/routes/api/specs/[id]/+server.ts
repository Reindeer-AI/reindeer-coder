import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { deleteSpec, getSpecById, specHasActiveEnvironments, updateSpec } from '$lib/server/db';
import { deleteSpecSecret, readSpecSecret, updateSpecSecret } from '$lib/server/specs/spec-store';
import type { RequestHandler } from './$types';

// GET /api/specs/:id - Get spec details (fetches content from Secret Manager)
export const GET: RequestHandler = async ({ params, request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const spec = await getSpecById(params.id);
	if (!spec) {
		throw error(404, 'Spec not found');
	}

	if (spec.user_id !== user.sub) {
		throw error(403, 'Access denied');
	}

	// Fetch actual content from Secret Manager
	let devcontainerJson: string;
	try {
		devcontainerJson = await readSpecSecret(spec.secret_path);
	} catch (err) {
		console.error(`[api/specs] Failed to read secret for spec ${params.id}:`, err);
		throw error(500, 'Failed to read spec content from Secret Manager');
	}

	return json({
		spec: {
			...spec,
			devcontainer_json: devcontainerJson,
		},
	});
};

// PUT /api/specs/:id - Update spec
export const PUT: RequestHandler = async ({ params, request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const spec = await getSpecById(params.id);
	if (!spec) {
		throw error(404, 'Spec not found');
	}

	if (spec.user_id !== user.sub) {
		throw error(403, 'Access denied');
	}

	let body: { name?: string; devcontainer_json?: string };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	// Update Secret Manager content if provided
	if (body.devcontainer_json) {
		try {
			JSON.parse(body.devcontainer_json);
		} catch {
			throw error(400, 'devcontainer_json must be valid JSON');
		}

		try {
			await updateSpecSecret(spec.secret_path, body.devcontainer_json);
		} catch (err) {
			console.error(`[api/specs] Failed to update secret for spec ${params.id}:`, err);
			throw error(500, 'Failed to update spec content in Secret Manager');
		}
	}

	if (body.name) {
		await updateSpec(params.id, { name: body.name });
		spec.name = body.name;
	}

	return json({ spec });
};

// DELETE /api/specs/:id - Delete spec
export const DELETE: RequestHandler = async ({ params, request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const spec = await getSpecById(params.id);
	if (!spec) {
		throw error(404, 'Spec not found');
	}

	if (spec.user_id !== user.sub) {
		throw error(403, 'Access denied');
	}

	// Check for active environments referencing this spec
	const hasActive = await specHasActiveEnvironments(params.id);
	if (hasActive) {
		throw error(409, 'Cannot delete spec with active environments. Delete environments first.');
	}

	// Delete from DB first (guaranteed to work), then best-effort SM cleanup
	await deleteSpec(params.id);
	deleteSpecSecret(spec.secret_path).catch((err) => {
		console.warn(`[api/specs] Failed to delete secret for spec ${params.id}:`, err);
	});

	return json({ success: true });
};
