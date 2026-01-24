import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getTaskById } from '$lib/server/db';
import { getActiveConnection, manualReconnect, touchConnection } from '$lib/server/vm/orchestrator';
import type { RequestHandler } from './$types';

// GET /api/tasks/:id/terminal/snapshot - Get terminal snapshot (non-SSE)
export const GET: RequestHandler = async ({ params, request }) => {
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

	// getTaskById already reads from terminal file if available
	const terminalBuffer = task.terminal_buffer || '';
	console.log(`[snapshot] Task ${params.id}: buffer length = ${terminalBuffer.length} chars`);

	// If no terminal content and task is running, trigger reconnect to start capturing
	if (!terminalBuffer && ['running', 'cloning'].includes(task.status) && task.vm_name) {
		const conn = getActiveConnection(params.id);
		if (!conn) {
			console.log(
				`[snapshot] No content and no connection for task ${params.id}, initiating reconnect...`
			);

			// Trigger reconnection in background
			manualReconnect(params.id).catch((err) => {
				console.error(`[snapshot] Reconnect failed for task ${params.id}:`, err);
			});

			// Return 202 Accepted - client should retry
			return new Response(
				JSON.stringify({
					status: 'reconnecting',
					message: 'Terminal connection is being established. Please try again in a few seconds.',
					retry_after: 3,
					terminal_buffer: '',
				}),
				{
					status: 202,
					headers: { 'Content-Type': 'application/json' },
				}
			);
		}
	}

	// Touch the connection to keep it alive
	// This updates lastActivity timestamp to prevent the connection from being marked as stale
	touchConnection(params.id);

	return json({
		terminal_buffer: terminalBuffer,
	});
};
