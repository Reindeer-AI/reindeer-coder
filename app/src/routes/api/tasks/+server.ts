import { error, json } from '@sveltejs/kit';
import { extractBearerToken, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { createTask, getAllTasks, getTasksByUserId } from '$lib/server/db';
import type { TaskCreateInput } from '$lib/server/db/schema';
import { needsAttention } from '$lib/server/terminal-storage';
import { startTask } from '$lib/server/vm/orchestrator';
import type { RequestHandler } from './$types';

// GET /api/tasks - List all tasks for the authenticated user
export const GET: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token);
	if (!user) {
		throw error(401, 'Invalid token');
	}

	// Admins can see all tasks
	const adminPermission = await configService.get(
		'auth.admin_permission',
		'admin',
		'ADMIN_PERMISSION'
	);
	const isAdmin = user.permissions.includes(adminPermission);
	const tasks = isAdmin ? await getAllTasks() : await getTasksByUserId(user.sub);

	// Add attention flags
	const tasksWithExtras = tasks.map((task) => ({
		...task,
		needsAttention: needsAttention(task.id, task.status),
	}));

	return json({ tasks: tasksWithExtras });
};

// POST /api/tasks - Create a new coding task
export const POST: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token);
	if (!user) {
		throw error(401, 'Invalid token');
	}

	let body: TaskCreateInput & {
		user_email?: string;
		linear_metadata?: {
			issue_id: string;
			issue_identifier: string;
			issue_url: string;
			issue_title: string;
		};
	};
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	// Validate required fields
	if (!body.repository || !body.base_branch || !body.task_description || !body.coding_cli) {
		throw error(
			400,
			'Missing required fields: repository, base_branch, task_description, coding_cli'
		);
	}

	// Validate coding_cli
	if (!['claude-code', 'gemini', 'codex'].includes(body.coding_cli)) {
		throw error(400, 'Invalid coding_cli. Must be one of: claude-code, gemini, codex');
	}

	// Clean trailing slashes from repository URL (common when copying from browser)
	body.repository = body.repository.replace(/\/+$/, '');

	// Create the task in database (prefer email from request body, fallback to token, then 'unknown')
	const userEmail = body.user_email || user.email || 'unknown';
	const task = await createTask(user.sub, userEmail, body, body.linear_metadata);

	// Start the VM and agent (async - returns immediately)
	startTask(task.id).catch((err) => {
		console.error(`Failed to start task ${task.id}:`, err);
	});

	return json({ task }, { status: 201 });
};
