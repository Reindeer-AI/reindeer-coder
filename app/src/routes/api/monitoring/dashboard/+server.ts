/**
 * Monitoring Dashboard API
 *
 * Provides comprehensive monitoring information for all tasks,
 * including AI analysis results, task states, and suggested actions.
 */

import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getAllTasks, getTasksByUserId } from '$lib/server/db';
import type { RequestHandler } from './$types';

interface TaskMonitoringInfo {
	id: string;
	status: string;
	repository: string;
	taskDescription: string;
	vmName: string | null;
	createdAt: string;
	updatedAt: string;
	// Monitoring data
	analysis: {
		state: string;
		summary: string;
		confidence: number;
		suggestedActions: string[];
		reasoning: string;
		timestamp: string;
	} | null;
	lastCheckTimestamp: string | null;
	autoContinueCount: number;
}

interface MonitoringDashboard {
	summary: {
		totalActiveTasks: number;
		tasksWorking: number;
		tasksIdle: number;
		tasksStuck: number;
		tasksCompleted: number;
		tasksNeedingInput: number;
	};
	tasks: TaskMonitoringInfo[];
	lastUpdate: string;
}

// GET /api/monitoring/dashboard - Get monitoring dashboard
export const GET: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	// Check if user is admin
	const adminPermission = await configService.get(
		'auth.admin_permission',
		'admin',
		'ADMIN_PERMISSION'
	);
	const isAdmin = user.permissions.includes(adminPermission);

	// Get tasks based on user role
	const tasks = isAdmin ? await getAllTasks() : await getTasksByUserId(user.sub);

	// Filter to active tasks only
	const activeTasks = tasks.filter((task) =>
		['running', 'cloning', 'initializing'].includes(task.status)
	);

	// Extract monitoring info
	const taskMonitoringInfo: TaskMonitoringInfo[] = activeTasks.map((task) => {
		const metadata = task.metadata as any;
		const monitoring = metadata?.monitoring;
		const analysis = monitoring?.last_analysis;

		return {
			id: task.id,
			status: task.status,
			repository: task.repository,
			taskDescription: task.task_description.substring(0, 200), // Truncate
			vmName: task.vm_name,
			createdAt: task.created_at,
			updatedAt: task.updated_at,
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
			autoContinueCount: monitoring?.auto_continue_count || 0,
		};
	});

	// Calculate summary statistics
	const summary = {
		totalActiveTasks: taskMonitoringInfo.length,
		tasksWorking: taskMonitoringInfo.filter((t) => t.analysis?.state === 'agent_working').length,
		tasksIdle: taskMonitoringInfo.filter((t) => t.analysis?.state === 'agent_idle_waiting').length,
		tasksStuck: taskMonitoringInfo.filter((t) => t.analysis?.state === 'agent_stuck').length,
		tasksCompleted: taskMonitoringInfo.filter((t) => t.analysis?.state === 'agent_completed')
			.length,
		tasksNeedingInput: taskMonitoringInfo.filter((t) => t.analysis?.state === 'agent_needs_input')
			.length,
	};

	const dashboard: MonitoringDashboard = {
		summary,
		tasks: taskMonitoringInfo,
		lastUpdate: new Date().toISOString(),
	};

	return json(dashboard);
};
