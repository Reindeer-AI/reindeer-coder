import { error, json } from '@sveltejs/kit';
import { extractBearerToken, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getTaskById } from '$lib/server/db';
import type { RequestHandler } from './$types';

// GET /api/tasks/:id/terminal/snapshot - Get terminal snapshot (non-SSE)
export const GET: RequestHandler = async ({ params, request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token);
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

	return json({
		terminal_buffer: task.terminal_buffer || '',
	});
};
