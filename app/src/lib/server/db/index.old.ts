import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { Task, TaskCreateInput, TaskStatus } from './schema';
import {
	ensureTerminalFilesDir,
	initTerminalFile,
	appendToTerminalFile,
	readTerminalFile,
	getTerminalFilePath,
	needsAttention
} from '../terminal-storage';
import { writeFileSync } from 'fs';

// Initialize database
const db = new Database('vibe-coding.db');

// Ensure terminal files directory exists
ensureTerminalFilesDir();

// Create tables
db.exec(`
	CREATE TABLE IF NOT EXISTS tasks (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		user_email TEXT NOT NULL,
		repository TEXT NOT NULL,
		base_branch TEXT NOT NULL,
		feature_branch TEXT,
		task_description TEXT NOT NULL,
		coding_cli TEXT NOT NULL,
		system_prompt TEXT,
		status TEXT NOT NULL DEFAULT 'pending',
		vm_name TEXT,
		terminal_buffer TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now')),
		updated_at TEXT NOT NULL DEFAULT (datetime('now'))
	)
`);

// Add terminal_file_path column if it doesn't exist (migration)
try {
	db.exec(`ALTER TABLE tasks ADD COLUMN terminal_file_path TEXT`);
	console.log('[db] Added terminal_file_path column to tasks table');
} catch (error: any) {
	// Column already exists, ignore error
	if (!error.message.includes('duplicate column name')) {
		console.error('[db] Error adding terminal_file_path column:', error);
	}
}

// Add Linear metadata columns if they don't exist (migration)
const linearColumns = ['linear_issue_id', 'linear_issue_identifier', 'linear_issue_url', 'linear_issue_title'];
for (const col of linearColumns) {
	try {
		db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
		console.log(`[db] Added ${col} column to tasks table`);
	} catch (error: any) {
		// Column already exists, ignore error
		if (!error.message.includes('duplicate column name')) {
			console.error(`[db] Error adding ${col} column:`, error);
		}
	}
}

// Add GitLab MR metadata columns if they don't exist (migration)
const gitlabColumns = ['gitlab_mr_iid', 'gitlab_mr_url', 'gitlab_project_id', 'gitlab_mr_last_review_sha'];
for (const col of gitlabColumns) {
	try {
		const columnType = col === 'gitlab_mr_iid' ? 'INTEGER' : 'TEXT';
		db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${columnType}`);
		console.log(`[db] Added ${col} column to tasks table`);
	} catch (error: any) {
		if (!error.message.includes('duplicate column name')) {
			console.error(`[db] Error adding ${col} column:`, error);
		}
	}
}

// Add vm_external_ip column if it doesn't exist (migration)
try {
	db.exec(`ALTER TABLE tasks ADD COLUMN vm_external_ip TEXT`);
	console.log('[db] Added vm_external_ip column to tasks table');
} catch (error: any) {
	// Column already exists, ignore error
	if (!error.message.includes('duplicate column name')) {
		console.error('[db] Error adding vm_external_ip column:', error);
	}
}

// Add vm_zone column if it doesn't exist (migration)
try {
	db.exec(`ALTER TABLE tasks ADD COLUMN vm_zone TEXT`);
	console.log('[db] Added vm_zone column to tasks table');
} catch (error: any) {
	// Column already exists, ignore error
	if (!error.message.includes('duplicate column name')) {
		console.error('[db] Error adding vm_zone column:', error);
	}
}

/**
 * Create a new task
 */
export function createTask(
	userId: string,
	userEmail: string,
	input: TaskCreateInput,
	linearMetadata?: {
		issue_id: string;
		issue_identifier: string;
		issue_url: string;
		issue_title: string;
	}
): Task {
	const id = uuidv4();
	const featureBranch = `vibe-coding/${id.slice(0, 8)}`;

	// Initialize terminal file for new task
	const terminalFilePath = initTerminalFile(id);

	const stmt = db.prepare(`
		INSERT INTO tasks (
			id, user_id, user_email, repository, base_branch, feature_branch,
			task_description, coding_cli, system_prompt, status, terminal_file_path,
			linear_issue_id, linear_issue_identifier, linear_issue_url, linear_issue_title
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
	`);

	stmt.run(
		id,
		userId,
		userEmail,
		input.repository,
		input.base_branch,
		featureBranch,
		input.task_description,
		input.coding_cli,
		input.system_prompt || null,
		terminalFilePath,
		linearMetadata?.issue_id || null,
		linearMetadata?.issue_identifier || null,
		linearMetadata?.issue_url || null,
		linearMetadata?.issue_title || null
	);

	return getTaskById(id)!;
}

/**
 * Get a task by ID
 */
export function getTaskById(id: string): Task | undefined {
	const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
	const task = stmt.get(id) as Task | undefined;

	// If task has terminal_file_path, load content from file
	if (task && task.terminal_file_path) {
		try {
			const fileContent = readTerminalFile(id);
			task.terminal_buffer = fileContent;
		} catch (error) {
			console.error(`[db] Failed to read terminal file for task ${id}:`, error);
			// Fall back to DB buffer if it exists
		}
	}

	return task;
}

// Columns to select for task lists (excludes terminal_buffer for performance)
const TASK_LIST_COLUMNS = 'id, user_id, user_email, repository, base_branch, feature_branch, task_description, coding_cli, system_prompt, status, vm_name, vm_zone, vm_external_ip, created_at, updated_at, linear_issue_id, linear_issue_identifier, linear_issue_url, linear_issue_title, gitlab_mr_iid, gitlab_mr_url, gitlab_project_id, gitlab_mr_last_review_sha';

/**
 * Get all tasks for a user (excludes deleted)
 */
export function getTasksByUserId(userId: string): Task[] {
	const stmt = db.prepare(`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC`);
	return stmt.all(userId) as Task[];
}

/**
 * Get all tasks (admin only, excludes deleted)
 */
export function getAllTasks(): Task[] {
	const stmt = db.prepare(`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE status != 'deleted' ORDER BY created_at DESC`);
	return stmt.all() as Task[];
}

/**
 * Get all active tasks with Linear metadata (for monitoring)
 */
export function getActiveTasksWithLinearMetadata(): Task[] {
	const stmt = db.prepare(`
		SELECT ${TASK_LIST_COLUMNS}
		FROM tasks
		WHERE status IN ('pending', 'provisioning', 'initializing', 'cloning', 'running')
		AND linear_issue_id IS NOT NULL
		ORDER BY created_at DESC
	`);
	return stmt.all() as Task[];
}

/**
 * Get tasks that need attention (running tasks with idle terminal for 5+ minutes)
 */
export function getTasksNeedingAttention(): Task[] {
	// Get all running tasks
	const stmt = db.prepare(`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE status = 'running'`);
	const runningTasks = stmt.all() as Task[];

	// Filter by needsAttention check
	return runningTasks.filter((task) => needsAttention(task.id, task.status));
}

/**
 * Update task status
 */
export function updateTaskStatus(id: string, status: TaskStatus): void {
	const stmt = db.prepare(`
		UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?
	`);
	stmt.run(status, id);
}

/**
 * Update task VM name
 */
export function updateTaskVmName(id: string, vmName: string): void {
	const stmt = db.prepare(`
		UPDATE tasks SET vm_name = ?, updated_at = datetime('now') WHERE id = ?
	`);
	stmt.run(vmName, id);
}

/**
 * Update task VM external IP
 */
export function updateTaskVmExternalIp(id: string, externalIp: string | null): void {
	const stmt = db.prepare(`
		UPDATE tasks SET vm_external_ip = ?, updated_at = datetime('now') WHERE id = ?
	`);
	stmt.run(externalIp, id);
}

/**
 * Update task VM zone
 */
export function updateTaskVmZone(id: string, zone: string): void {
	const stmt = db.prepare(`
		UPDATE tasks SET vm_zone = ?, updated_at = datetime('now') WHERE id = ?
	`);
	stmt.run(zone, id);
}

/**
 * Append to terminal buffer
 */
export function appendTerminalBuffer(id: string, content: string): void {
	const task = getTaskById(id);
	if (!task) return;

	// New tasks: use file storage
	if (task.terminal_file_path) {
		try {
			appendToTerminalFile(id, content);
		} catch (error) {
			console.error(`[db] Failed to append to terminal file for task ${id}:`, error);
			// Fall back to DB storage on error
			const newBuffer = (task.terminal_buffer || '') + content;
			const stmt = db.prepare(`
				UPDATE tasks SET terminal_buffer = ?, updated_at = datetime('now') WHERE id = ?
			`);
			stmt.run(newBuffer, id);
		}
	}
	// Old tasks: use DB storage
	else {
		const newBuffer = (task.terminal_buffer || '') + content;
		const stmt = db.prepare(`
			UPDATE tasks SET terminal_buffer = ?, updated_at = datetime('now') WHERE id = ?
		`);
		stmt.run(newBuffer, id);
	}
}

/**
 * Soft delete a task (marks as deleted, preserves for analytics)
 */
export function deleteTask(id: string): void {
	const stmt = db.prepare(`
		UPDATE tasks SET status = 'deleted', updated_at = datetime('now') WHERE id = ?
	`);
	stmt.run(id);
}

/**
 * Reset a task for retry - clears VM info and terminal buffer
 */
export function resetTaskForRetry(id: string): void {
	const task = getTaskById(id);
	if (!task) return;

	const retryMessage = '[system] Retrying task...\r\n';

	// If task uses file storage, reset the file
	if (task.terminal_file_path) {
		try {
			const filePath = getTerminalFilePath(id);
			writeFileSync(filePath, retryMessage, 'utf-8');
		} catch (error) {
			console.error(`[db] Failed to reset terminal file for task ${id}:`, error);
		}
	}

	const stmt = db.prepare(`
		UPDATE tasks
		SET status = 'pending',
			vm_name = NULL,
			vm_zone = NULL,
			vm_external_ip = NULL,
			terminal_buffer = ?,
			updated_at = datetime('now')
		WHERE id = ?
	`);
	stmt.run(task.terminal_file_path ? null : retryMessage, id);
}

/**
 * Update GitLab MR metadata for a task
 */
export function updateTaskGitLabMetadata(
	id: string,
	metadata: {
		mr_iid?: number;
		mr_url?: string;
		project_id?: string;
		last_review_sha?: string;
	}
): void {
	const fields: string[] = [];
	const values: any[] = [];

	if (metadata.mr_iid !== undefined) {
		fields.push('gitlab_mr_iid = ?');
		values.push(metadata.mr_iid);
	}
	if (metadata.mr_url !== undefined) {
		fields.push('gitlab_mr_url = ?');
		values.push(metadata.mr_url);
	}
	if (metadata.project_id !== undefined) {
		fields.push('gitlab_project_id = ?');
		values.push(metadata.project_id);
	}
	if (metadata.last_review_sha !== undefined) {
		fields.push('gitlab_mr_last_review_sha = ?');
		values.push(metadata.last_review_sha);
	}

	if (fields.length === 0) return;

	fields.push("updated_at = datetime('now')");
	const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`;
	values.push(id);

	const stmt = db.prepare(sql);
	stmt.run(...values);
}

/**
 * Dashboard metrics interface
 */
export interface DashboardMetrics {
	totalTasks: number;
	activeTasks: number;
	statusBreakdown: { status: TaskStatus; count: number; percentage: number }[];
	agentBreakdown: { coding_cli: string; count: number; percentage: number }[];
	userStats: { totalUsers: number; mostActiveUsers: { user_email: string; task_count: number }[] };
	successMetrics: { completionRate: number; failureRate: number; completed: number; failed: number };
	recentActivity: { latestTasks: Task[]; recentFailures: Task[] };
	timeSeriesData: { date: string; count: number }[];
	runningVMs: { vm_name: string; task_id: string; status: TaskStatus }[];
}

/**
 * Get dashboard metrics for a specific user
 */
export function getDashboardMetrics(userId: string): DashboardMetrics {
	// Total and active tasks
	const totalTasksResult = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ?').get(userId) as { count: number };
	const totalTasks = totalTasksResult.count;

	const activeTasksResult = db.prepare(
		"SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status IN ('pending', 'provisioning', 'initializing', 'cloning', 'running')"
	).get(userId) as { count: number };
	const activeTasks = activeTasksResult.count;

	// Status breakdown
	const statusBreakdown = db.prepare(`
		SELECT status, COUNT(*) as count
		FROM tasks
		WHERE user_id = ?
		GROUP BY status
	`).all(userId) as { status: TaskStatus; count: number }[];

	const statusBreakdownWithPercentage = statusBreakdown.map((s) => ({
		...s,
		percentage: totalTasks > 0 ? Math.round((s.count / totalTasks) * 100) : 0
	}));

	// Agent breakdown
	const agentBreakdown = db.prepare(`
		SELECT coding_cli, COUNT(*) as count
		FROM tasks
		WHERE user_id = ?
		GROUP BY coding_cli
	`).all(userId) as { coding_cli: string; count: number }[];

	const agentBreakdownWithPercentage = agentBreakdown.map((a) => ({
		...a,
		percentage: totalTasks > 0 ? Math.round((a.count / totalTasks) * 100) : 0
	}));

	// User stats (for individual user, just show their total)
	const userStats = {
		totalUsers: 1,
		mostActiveUsers: [] as { user_email: string; task_count: number }[]
	};

	// Success metrics
	const successMetrics = db.prepare(`
		SELECT
			SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
			SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
		FROM tasks
		WHERE user_id = ?
	`).get(userId) as { completed: number | null; failed: number | null };

	const completed = successMetrics.completed || 0;
	const failed = successMetrics.failed || 0;
	const total = completed + failed;
	const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
	const failureRate = total > 0 ? Math.round((failed / total) * 100) : 0;

	// Recent activity
	const latestTasks = db.prepare(
		`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`
	).all(userId) as Task[];

	const recentFailures = db.prepare(
		`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE user_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 5`
	).all(userId) as Task[];

	// Time series (last 7 days)
	const timeSeriesData = db.prepare(`
		SELECT DATE(created_at) as date, COUNT(*) as count
		FROM tasks
		WHERE user_id = ? AND created_at >= DATE('now', '-7 days')
		GROUP BY DATE(created_at)
		ORDER BY date ASC
	`).all(userId) as { date: string; count: number }[];

	// Running VMs
	const runningVMs = db.prepare(`
		SELECT vm_name, id as task_id, status
		FROM tasks
		WHERE user_id = ? AND vm_name IS NOT NULL AND status IN ('running', 'cloning', 'provisioning', 'initializing')
	`).all(userId) as { vm_name: string; task_id: string; status: TaskStatus }[];

	return {
		totalTasks,
		activeTasks,
		statusBreakdown: statusBreakdownWithPercentage,
		agentBreakdown: agentBreakdownWithPercentage,
		userStats,
		successMetrics: { completed, failed, completionRate, failureRate },
		recentActivity: { latestTasks, recentFailures },
		timeSeriesData,
		runningVMs
	};
}

/**
 * Get dashboard metrics for all users (admin only)
 */
export function getAllDashboardMetrics(): DashboardMetrics {
	// Total and active tasks
	const totalTasksResult = db.prepare('SELECT COUNT(*) as count FROM tasks').get() as { count: number };
	const totalTasks = totalTasksResult.count;

	const activeTasksResult = db.prepare(
		"SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'provisioning', 'initializing', 'cloning', 'running')"
	).get() as { count: number };
	const activeTasks = activeTasksResult.count;

	// Status breakdown
	const statusBreakdown = db.prepare(`
		SELECT status, COUNT(*) as count
		FROM tasks
		GROUP BY status
	`).all() as { status: TaskStatus; count: number }[];

	const statusBreakdownWithPercentage = statusBreakdown.map((s) => ({
		...s,
		percentage: totalTasks > 0 ? Math.round((s.count / totalTasks) * 100) : 0
	}));

	// Agent breakdown
	const agentBreakdown = db.prepare(`
		SELECT coding_cli, COUNT(*) as count
		FROM tasks
		GROUP BY coding_cli
	`).all() as { coding_cli: string; count: number }[];

	const agentBreakdownWithPercentage = agentBreakdown.map((a) => ({
		...a,
		percentage: totalTasks > 0 ? Math.round((a.count / totalTasks) * 100) : 0
	}));

	// User stats
	const totalUsersResult = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM tasks').get() as { count: number };
	const mostActiveUsers = db.prepare(`
		SELECT user_email, COUNT(*) as task_count
		FROM tasks
		GROUP BY user_email
		ORDER BY task_count DESC
		LIMIT 5
	`).all() as { user_email: string; task_count: number }[];

	const userStats = {
		totalUsers: totalUsersResult.count,
		mostActiveUsers
	};

	// Success metrics
	const successMetrics = db.prepare(`
		SELECT
			SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
			SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
		FROM tasks
	`).get() as { completed: number | null; failed: number | null };

	const completed = successMetrics.completed || 0;
	const failed = successMetrics.failed || 0;
	const total = completed + failed;
	const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
	const failureRate = total > 0 ? Math.round((failed / total) * 100) : 0;

	// Recent activity
	const latestTasks = db.prepare(
		`SELECT ${TASK_LIST_COLUMNS} FROM tasks ORDER BY created_at DESC LIMIT 10`
	).all() as Task[];

	const recentFailures = db.prepare(
		`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 10`
	).all() as Task[];

	// Time series (last 7 days)
	const timeSeriesData = db.prepare(`
		SELECT DATE(created_at) as date, COUNT(*) as count
		FROM tasks
		WHERE created_at >= DATE('now', '-7 days')
		GROUP BY DATE(created_at)
		ORDER BY date ASC
	`).all() as { date: string; count: number }[];

	// Running VMs
	const runningVMs = db.prepare(`
		SELECT vm_name, id as task_id, status
		FROM tasks
		WHERE vm_name IS NOT NULL AND status IN ('running', 'cloning', 'provisioning', 'initializing')
	`).all() as { vm_name: string; task_id: string; status: TaskStatus }[];

	return {
		totalTasks,
		activeTasks,
		statusBreakdown: statusBreakdownWithPercentage,
		agentBreakdown: agentBreakdownWithPercentage,
		userStats,
		successMetrics: { completed, failed, completionRate, failureRate },
		recentActivity: { latestTasks, recentFailures },
		timeSeriesData,
		runningVMs
	};
}

export type { Task, TaskCreateInput, TaskStatus } from './schema';
