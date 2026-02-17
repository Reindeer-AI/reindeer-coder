import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { createTask, getAllTasks, getTasksByUserId } from '$lib/server/db';
import type { TaskCreateInput } from '$lib/server/db/schema';
import { startTask } from '$lib/server/vm/orchestrator';
import type { RequestHandler } from './$types';

// GET /api/tasks - List all tasks for the authenticated user
export const GET: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
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

	// Add AI analysis status (replaces old needsAttention flag)
	const tasksWithExtras = tasks.map((task) => {
		// Extract monitoring data from metadata
		const metadata = task.metadata as any;
		const monitoring = metadata?.monitoring;
		const analysis = monitoring?.last_analysis;

		// Determine if task needs attention based on AI analysis
		// This replaces the old time-based needsAttention check
		const needsAttention =
			analysis &&
			(analysis.state === 'agent_needs_input' ||
				analysis.state === 'agent_stuck' ||
				analysis.state === 'agent_idle_waiting' ||
				analysis.state === 'agent_completed');

		return {
			...task,
			// New AI-based attention flag (replaces old logic)
			needsAttention: needsAttention || false,
			// Include full analysis for dashboard
			analysis: analysis
				? {
						state: analysis.state,
						summary: analysis.summary,
						confidence: analysis.confidence,
						suggestedActions: analysis.suggestedActions || [],
						reasoning: analysis.reasoning,
						timestamp: analysis.timestamp,
					}
				: null,
			lastCheckTimestamp: monitoring?.last_check_timestamp || null,
		};
	});

	return json({ tasks: tasksWithExtras });
};

// POST /api/tasks - Create a new coding task
export const POST: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
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
