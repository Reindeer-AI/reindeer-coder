import { error } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getTaskById } from '$lib/server/db';
import { resizeTerminal } from '$lib/server/vm/orchestrator';
import type { RequestHandler } from './$types';

// POST to send terminal resize event
export const POST: RequestHandler = async ({ params, request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const task = await getTaskById(params.id);
	if (!task) {
		throw error(404, 'Task not found');
	}

	// Check ownership
	const adminPermission = await configService.get(
		'auth.admin_permission',
		'admin',
		'ADMIN_PERMISSION'
	);
	const isAdmin = user.permissions.includes(adminPermission);
	if (!isAdmin && task.user_id !== user.sub) {
		throw error(403, 'Access denied');
	}

	if (task.status !== 'running') {
		throw error(400, 'Task is not running');
	}

	const body = await request.json();
	const cols = body.cols as number;
	const rows = body.rows as number;

	if (!cols || !rows || cols <= 0 || rows <= 0) {
		throw error(400, 'Invalid terminal dimensions');
	}

	// Send resize event to tmux
	console.log(`[terminal:resize] Task ${params.id}: resizing to ${cols}x${rows}`);
	resizeTerminal(params.id, cols, rows);

	return new Response(JSON.stringify({ success: true }), {
		headers: { 'Content-Type': 'application/json' },
	});
};
