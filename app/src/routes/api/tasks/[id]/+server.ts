import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { deleteTask, getTaskById, resetTaskForRetry, updateTaskStatus } from '$lib/server/db';
import { getTerminalPreview, needsAttention } from '$lib/server/terminal-storage';
import { completeTask, sendInstruction, startTask, stopTask } from '$lib/server/vm/orchestrator';
import type { RequestHandler } from './$types';

// GET /api/tasks/:id - Get a specific task
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

	// Check ownership (admins can see any task)
	const adminPermission = await configService.get(
		'auth.admin_permission',
		'admin',
		'ADMIN_PERMISSION'
	);
	const isAdmin = user.permissions.includes(adminPermission);
	if (!isAdmin && task.user_id !== user.sub) {
		throw error(403, 'Access denied');
	}

	// Add terminal preview and attention flag for single task view
	const taskWithExtras = {
		...task,
		needsAttention: needsAttention(task.id, task.status),
		terminalPreview: getTerminalPreview(task.id, 20),
	};

	return json({ task: taskWithExtras });
};

// PATCH /api/tasks/:id - Send instruction to running task
export const PATCH: RequestHandler = async ({ params, request }) => {
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

	// Task must be running to receive instructions
	if (task.status !== 'running') {
		throw error(400, `Cannot send instruction to task with status: ${task.status}`);
	}

	let body: { instruction: string };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	if (!body.instruction) {
		throw error(400, 'Missing required field: instruction');
	}

	// Send instruction to the running agent
	try {
		await sendInstruction(task.id, body.instruction);
	} catch (err) {
		const errMessage = err instanceof Error ? err.message : 'Unknown error';
		console.error(`Failed to send instruction to task ${task.id}:`, err);
		throw error(500, errMessage);
	}

	return json({ success: true });
};

// DELETE /api/tasks/:id - Stop and delete a task
export const DELETE: RequestHandler = async ({ params, request }) => {
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

	// Stop the VM if running
	if (['provisioning', 'cloning', 'running'].includes(task.status)) {
		try {
			await stopTask(task.id);
		} catch (err) {
			console.error(`Failed to stop task ${task.id}:`, err);
		}
	}

	// Delete from database
	await deleteTask(params.id);

	return json({ success: true });
};

// PUT /api/tasks/:id - Complete a task and clean up resources
export const PUT: RequestHandler = async ({ params, request }) => {
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

	// Complete the task and clean up resources
	try {
		await completeTask(task.id);
	} catch (err) {
		console.error(`Failed to complete task ${task.id}:`, err);
		throw error(500, 'Failed to complete task');
	}

	return json({ success: true, message: 'Task completed' });
};

// POST /api/tasks/:id - Retry a failed/stopped task
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

	// Allow retry for any non-pending task (stop it first if running)
	if (task.status === 'pending') {
		throw error(400, `Task is already pending, wait for it to start`);
	}

	// Stop any existing VM if task is running or has a VM
	if (['provisioning', 'cloning', 'running'].includes(task.status) || task.vm_name) {
		try {
			await stopTask(task.id);
		} catch (err) {
			console.error(`Failed to stop existing VM for task ${task.id}:`, err);
		}
	}

	// Reset task state
	await resetTaskForRetry(task.id);

	// Start the task again
	startTask(task.id).catch(async (err) => {
		console.error(`Failed to start task ${task.id}:`, err);
		await updateTaskStatus(task.id, 'failed');
	});

	return json({ success: true, message: 'Task retry started' });
};
