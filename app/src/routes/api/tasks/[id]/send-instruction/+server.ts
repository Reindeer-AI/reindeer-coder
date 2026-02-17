import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getTaskById } from '$lib/server/db';
import { sendInstruction } from '$lib/server/vm/orchestrator';
import type { RequestHandler } from './$types';

// POST /api/tasks/:id/send-instruction - Send a custom instruction to the agent
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

	// Get the instruction from request body
	const body = await request.json();
	const { instruction } = body;

	if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
		throw error(400, 'Instruction text is required');
	}

	// Send the instruction to the agent
	try {
		await sendInstruction(params.id, instruction);

		return json({
			success: true,
			message: 'Instruction sent to agent',
		});
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		throw error(500, `Failed to send instruction: ${errorMessage}`);
	}
};
