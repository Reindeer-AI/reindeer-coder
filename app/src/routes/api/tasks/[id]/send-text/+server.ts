import { error, json } from '@sveltejs/kit';
import { extractBearerToken, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getTaskById } from '$lib/server/db';
import { getActiveConnection } from '$lib/server/vm/orchestrator';
import type { RequestHandler } from './$types';

// POST /api/tasks/:id/send-text - Send text to terminal
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

	if (task.status !== 'running') {
		throw error(400, 'Task is not running');
	}

	const body = await request.json();
	const text = body.text as string;

	if (!text) {
		throw error(400, 'Missing text field');
	}

	// Get active SSH connection and write to it
	const conn = getActiveConnection(params.id);
	if (!conn) {
		throw error(500, 'No active connection for task');
	}

	// Write to the SSH connection
	console.log(`[send-text] Sending text to task ${params.id}: ${JSON.stringify(text)}`);
	conn.write(text);

	return json({ success: true });
};
