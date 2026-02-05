import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getTaskById } from '$lib/server/db';
import { taskStatusMonitor } from '$lib/server/tasks/task-status-monitor';
import type { RequestHandler } from './$types';

// POST /api/tasks/:id/continue - Manually continue an agent with a prompt
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

	// Get the latest analysis
	const analysis = await taskStatusMonitor.getLatestAnalysis(params.id);

	if (!analysis) {
		throw error(400, 'No analysis available. Please analyze the task first.');
	}

	// Attempt to auto-continue the agent
	try {
		const success = await taskStatusMonitor.autoContinueAgent(task, analysis);

		if (!success) {
			throw error(
				400,
				'Failed to continue agent. The task may not have an active connection.'
			);
		}

		return json({
			success: true,
			message: 'Agent prompted to continue',
			analysis,
		});
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		throw error(500, `Failed to continue agent: ${errorMessage}`);
	}
};
