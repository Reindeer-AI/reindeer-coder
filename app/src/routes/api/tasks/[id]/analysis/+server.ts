import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getTaskById } from '$lib/server/db';
import { taskStatusMonitor } from '$lib/server/tasks/task-status-monitor';
import type { RequestHandler } from './$types';

// GET /api/tasks/:id/analysis - Get the latest AI analysis of task status
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

	// Get the latest analysis from task metadata
	const analysis = await taskStatusMonitor.getLatestAnalysis(params.id);

	if (!analysis) {
		return json({
			analysis: null,
			message: 'No analysis available yet. Try triggering a new analysis with POST.',
		});
	}

	return json({ analysis });
};

// POST /api/tasks/:id/analysis - Trigger a new AI analysis
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

	// Trigger a new analysis
	try {
		const analysis = await taskStatusMonitor.analyzeTaskNow(params.id);

		return json(
			{
				analysis,
				message: 'Analysis completed successfully',
			},
			{ status: 201 }
		);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		throw error(400, `Failed to analyze task: ${errorMessage}`);
	}
};
