import { error, json } from '@sveltejs/kit';
import { extractBearerToken, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getTaskById } from '$lib/server/db';
import { manualReconnect } from '$lib/server/vm/orchestrator';
import type { RequestHandler } from './$types';

// POST to manually reconnect to a task's VM
export const POST: RequestHandler = async ({ params, request }) => {
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

	// Only allow reconnect for running tasks with a VM
	if (!task.vm_name) {
		throw error(400, 'Task has no VM associated');
	}

	if (!['running', 'cloning'].includes(task.status)) {
		throw error(400, 'Task is not in a running state');
	}

	console.log(`[reconnect:api] Manual reconnect requested for task ${params.id}`);

	try {
		const success = await manualReconnect(params.id);
		return json({ success, message: success ? 'Reconnected successfully' : 'Reconnection failed' });
	} catch (err) {
		console.error(`[reconnect:api] Error:`, err);
		throw error(500, err instanceof Error ? err.message : 'Reconnection failed');
	}
};
