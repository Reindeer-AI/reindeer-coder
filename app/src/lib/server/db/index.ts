import { writeFileSync } from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import {
	appendToTerminalFile,
	ensureTerminalFilesDir,
	getTerminalFilePath,
	initTerminalFile,
	needsAttention,
	readTerminalFile,
} from '../terminal-storage';
import type { DbRow, SqlValue } from './adapter';
import { createAdapter, getDatabaseConfigFromEnv } from './config';
import type { PostgresAdapter } from './postgres-adapter';
import type { Task, TaskCreateInput, TaskMetadata, TaskStatus } from './schema';
import { SqlBuilder } from './sql-builder';
import type { SqliteAdapter } from './sqlite-adapter';

// Initialize database from environment configuration
const dbConfig = getDatabaseConfigFromEnv();
// Initialize adapter immediately (using top-level await)
const adapter = await createAdapter(dbConfig);
const sqlBuilder = new SqlBuilder(dbConfig.type);

// Ensure terminal files directory exists
ensureTerminalFilesDir();

// Helper to determine if adapter is async (PostgreSQL)
const isAsync = dbConfig.type === 'postgres';

/**
 * Initialize database schema and run migrations
 */
async function initializeDatabase() {
	console.log('[db] Initializing database schema...');

	// Create tables
	const createTableSql = sqlBuilder.getCreateTableSql();
	if (isAsync) {
		await (adapter as PostgresAdapter).exec(createTableSql);
	} else {
		adapter.exec(createTableSql);
	}

	// Run migrations
	await runMigrations();

	console.log('[db] Database initialized successfully');
}

/**
 * Run database migrations
 */
async function runMigrations() {
	console.log('[db] Running migrations...');

	// Migration: Add terminal_file_path column
	await addColumnIfNotExists('tasks', 'terminal_file_path', 'TEXT');

	// Migration: Add vm_external_ip column
	await addColumnIfNotExists('tasks', 'vm_external_ip', 'TEXT');

	// Migration: Add vm_zone column
	await addColumnIfNotExists('tasks', 'vm_zone', 'TEXT');

	// Migration: Add MR/PR columns (generic, works with GitLab/GitHub)
	// These replace the old gitlab_* prefixed columns
	const mrColumns = [
		{ name: 'mr_iid', type: 'INTEGER' },
		{ name: 'mr_url', type: 'TEXT' },
		{ name: 'project_id', type: 'TEXT' },
		{ name: 'mr_last_review_sha', type: 'TEXT' },
	];
	for (const col of mrColumns) {
		await addColumnIfNotExists('tasks', col.name, col.type);
	}

	// Migration: Add metadata JSON column for integrations (Linear, Jira, etc.)
	const metadataType = dbConfig.type === 'postgres' ? 'JSONB' : 'TEXT';
	await addColumnIfNotExists('tasks', 'metadata', metadataType);

	console.log('[db] Migrations completed');
}

/**
 * Add column to table if it doesn't exist
 */
async function addColumnIfNotExists(tableName: string, columnName: string, columnType: string) {
	try {
		const hasCol = await adapter.hasColumn(tableName, columnName);
		if (!hasCol) {
			const sql = sqlBuilder.addColumnIfNotExists(tableName, columnName, columnType);
			if (isAsync) {
				await (adapter as PostgresAdapter).exec(sql);
			} else {
				adapter.exec(sql);
			}
			console.log(`[db] Added ${columnName} column to ${tableName} table`);
		}
	} catch (error) {
		// For SQLite, check if it's a duplicate column error
		const errMsg = error instanceof Error ? error.message : '';
		if (dbConfig.type === 'sqlite' && errMsg.includes('duplicate column name')) {
			// Column already exists, ignore
		} else {
			console.error(`[db] Error adding ${columnName} column:`, error);
		}
	}
}

// Initialize database (run migrations)
initializeDatabase().catch((error) => {
	console.error('[db] Failed to initialize database:', error);
	process.exit(1);
});

/**
 * Create a new task
 */
export async function createTask(
	userId: string,
	userEmail: string,
	input: TaskCreateInput,
	linearMetadata?: {
		issue_id: string;
		issue_identifier: string;
		issue_url: string;
		issue_title: string;
	}
): Promise<Task> {
	const id = uuidv4();
	const featureBranch = `vibe-coding/${id.slice(0, 8)}`;

	// Initialize terminal file for new task
	const terminalFilePath = initTerminalFile(id);

	// Build metadata JSON if Linear data provided
	let metadata: TaskMetadata | null = null;
	if (linearMetadata) {
		metadata = {
			linear: {
				issue_id: linearMetadata.issue_id,
				issue_identifier: linearMetadata.issue_identifier,
				issue_url: linearMetadata.issue_url,
				issue_title: linearMetadata.issue_title,
				connection_commands_posted: false,
				attention_check_posted: false,
			},
		};
	}

	const sql = `
		INSERT INTO tasks (
			id, user_id, user_email, repository, base_branch, feature_branch,
			task_description, coding_cli, system_prompt, status, terminal_file_path, metadata
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
	`;

	const params = [
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
		metadata ? JSON.stringify(metadata) : null,
	];

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, params);
	} else {
		adapter.run(sql, params);
	}

	const task = await getTaskById(id);
	if (!task) {
		throw new Error(`Failed to retrieve created task ${id}`);
	}
	return task;
}

/**
 * Parse metadata JSON from DB result
 */
function parseTaskMetadata(row: DbRow): Task {
	if (row?.metadata) {
		if (typeof row.metadata === 'string') {
			try {
				row.metadata = JSON.parse(row.metadata);
			} catch {
				row.metadata = null;
			}
		}
	}
	return row as unknown as Task;
}

/**
 * Parse metadata for multiple tasks
 */
function parseTasksMetadata(rows: DbRow[]): Task[] {
	return rows.map(parseTaskMetadata);
}

/**
 * Get a task by ID
 */
export async function getTaskById(id: string): Promise<Task | undefined> {
	const sql = 'SELECT * FROM tasks WHERE id = ?';
	let row: DbRow | undefined;

	if (isAsync) {
		row = await (adapter as PostgresAdapter).get(sql, [id]);
	} else {
		row = (adapter as SqliteAdapter).get(sql, [id]) as DbRow | undefined;
	}

	if (!row) return undefined;

	// Parse metadata JSON
	const task = parseTaskMetadata(row);

	// If task has terminal_file_path, load content from file
	if (task.terminal_file_path) {
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
const TASK_LIST_COLUMNS =
	'id, user_id, user_email, repository, base_branch, feature_branch, task_description, coding_cli, system_prompt, status, vm_name, vm_zone, vm_external_ip, created_at, updated_at, mr_iid, mr_url, project_id, mr_last_review_sha, metadata';

/**
 * Get all tasks for a user (excludes deleted)
 */
export async function getTasksByUserId(userId: string): Promise<Task[]> {
	const sql = `SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC`;

	let rows: DbRow[];
	if (isAsync) {
		rows = await (adapter as PostgresAdapter).all(sql, [userId]);
	} else {
		rows = (adapter as SqliteAdapter).all(sql, [userId]) as DbRow[];
	}
	return parseTasksMetadata(rows);
}

/**
 * Get all tasks (admin only, excludes deleted)
 */
export async function getAllTasks(): Promise<Task[]> {
	const sql = `SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE status != 'deleted' ORDER BY created_at DESC`;

	let rows: DbRow[];
	if (isAsync) {
		rows = await (adapter as PostgresAdapter).all(sql, []);
	} else {
		rows = (adapter as SqliteAdapter).all(sql, []) as DbRow[];
	}
	return parseTasksMetadata(rows);
}

/**
 * Get all active tasks with Linear metadata (for monitoring)
 */
export async function getActiveTasksWithLinearMetadata(): Promise<Task[]> {
	// Query for tasks with Linear metadata in JSON
	// SQLite: metadata LIKE '%"linear":%'
	// PostgreSQL: metadata->'linear' IS NOT NULL
	const linearCondition =
		dbConfig.type === 'postgres'
			? "metadata->'linear' IS NOT NULL"
			: 'metadata LIKE \'%"linear":%\'';

	const sql = `
		SELECT ${TASK_LIST_COLUMNS}
		FROM tasks
		WHERE status IN ('pending', 'provisioning', 'initializing', 'cloning', 'running')
		AND ${linearCondition}
		ORDER BY created_at DESC
	`;

	let rows: DbRow[];
	if (isAsync) {
		rows = await (adapter as PostgresAdapter).all(sql, []);
	} else {
		rows = (adapter as SqliteAdapter).all(sql, []) as DbRow[];
	}
	return parseTasksMetadata(rows);
}

/**
 * Get tasks that need attention (running tasks with idle terminal for 5+ minutes)
 */
export async function getTasksNeedingAttention(): Promise<Task[]> {
	// Get all running tasks
	const sql = `SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE status = 'running'`;

	let rows: DbRow[];
	if (isAsync) {
		rows = await (adapter as PostgresAdapter).all(sql, []);
	} else {
		rows = (adapter as SqliteAdapter).all(sql, []) as DbRow[];
	}

	const runningTasks = parseTasksMetadata(rows);

	// Filter by needsAttention check
	return runningTasks.filter((task) => needsAttention(task.id, task.status));
}

/**
 * Update task status
 */
export async function updateTaskStatus(id: string, status: TaskStatus): Promise<void> {
	const sql = `UPDATE tasks SET status = ?, updated_at = ${sqlBuilder.now()} WHERE id = ?`;

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, [status, id]);
	} else {
		adapter.run(sql, [status, id]);
	}
}

/**
 * Update task VM name
 */
export async function updateTaskVmName(id: string, vmName: string): Promise<void> {
	const sql = `UPDATE tasks SET vm_name = ?, updated_at = ${sqlBuilder.now()} WHERE id = ?`;

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, [vmName, id]);
	} else {
		adapter.run(sql, [vmName, id]);
	}
}

/**
 * Update task VM external IP
 */
export async function updateTaskVmExternalIp(id: string, externalIp: string | null): Promise<void> {
	const sql = `UPDATE tasks SET vm_external_ip = ?, updated_at = ${sqlBuilder.now()} WHERE id = ?`;

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, [externalIp, id]);
	} else {
		adapter.run(sql, [externalIp, id]);
	}
}

/**
 * Update task VM zone
 */
export async function updateTaskVmZone(id: string, zone: string): Promise<void> {
	const sql = `UPDATE tasks SET vm_zone = ?, updated_at = ${sqlBuilder.now()} WHERE id = ?`;

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, [zone, id]);
	} else {
		adapter.run(sql, [zone, id]);
	}
}

/**
 * Append to terminal buffer
 */
export async function appendTerminalBuffer(id: string, content: string): Promise<void> {
	const task = await getTaskById(id);
	if (!task) return;

	// New tasks: use file storage
	if (task.terminal_file_path) {
		try {
			appendToTerminalFile(id, content);
		} catch (error) {
			console.error(`[db] Failed to append to terminal file for task ${id}:`, error);
			// Fall back to DB storage on error
			const newBuffer = (task.terminal_buffer || '') + content;
			const sql = `UPDATE tasks SET terminal_buffer = ?, updated_at = ${sqlBuilder.now()} WHERE id = ?`;

			if (isAsync) {
				await (adapter as PostgresAdapter).run(sql, [newBuffer, id]);
			} else {
				adapter.run(sql, [newBuffer, id]);
			}
		}
	}
	// Old tasks: use DB storage
	else {
		const newBuffer = (task.terminal_buffer || '') + content;
		const sql = `UPDATE tasks SET terminal_buffer = ?, updated_at = ${sqlBuilder.now()} WHERE id = ?`;

		if (isAsync) {
			await (adapter as PostgresAdapter).run(sql, [newBuffer, id]);
		} else {
			adapter.run(sql, [newBuffer, id]);
		}
	}
}

/**
 * Soft delete a task (marks as deleted, preserves for analytics)
 */
export async function deleteTask(id: string): Promise<void> {
	const sql = `UPDATE tasks SET status = 'deleted', updated_at = ${sqlBuilder.now()} WHERE id = ?`;

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, [id]);
	} else {
		adapter.run(sql, [id]);
	}
}

/**
 * Reset a task for retry - clears VM info and terminal buffer
 */
export async function resetTaskForRetry(id: string): Promise<void> {
	const task = await getTaskById(id);
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

	const sql = `
		UPDATE tasks
		SET status = 'pending',
			vm_name = NULL,
			vm_zone = NULL,
			vm_external_ip = NULL,
			terminal_buffer = ?,
			updated_at = ${sqlBuilder.now()}
		WHERE id = ?
	`;

	const params = [task.terminal_file_path ? null : retryMessage, id];

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, params);
	} else {
		adapter.run(sql, params);
	}
}

/**
 * Update MR/PR metadata for a task (works with GitLab, GitHub, etc.)
 */
export async function updateTaskMRMetadata(
	id: string,
	mrMetadata: {
		mr_iid?: number;
		mr_url?: string;
		project_id?: string;
		last_review_sha?: string;
	}
): Promise<void> {
	const fields: string[] = [];
	const values: SqlValue[] = [];

	if (mrMetadata.mr_iid !== undefined) {
		fields.push('mr_iid = ?');
		values.push(mrMetadata.mr_iid);
	}
	if (mrMetadata.mr_url !== undefined) {
		fields.push('mr_url = ?');
		values.push(mrMetadata.mr_url);
	}
	if (mrMetadata.project_id !== undefined) {
		fields.push('project_id = ?');
		values.push(mrMetadata.project_id);
	}
	if (mrMetadata.last_review_sha !== undefined) {
		fields.push('mr_last_review_sha = ?');
		values.push(mrMetadata.last_review_sha);
	}

	if (fields.length === 0) return;

	fields.push(`updated_at = ${sqlBuilder.now()}`);
	const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`;
	values.push(id);

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, values);
	} else {
		adapter.run(sql, values);
	}
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
	successMetrics: {
		completionRate: number;
		failureRate: number;
		completed: number;
		failed: number;
	};
	recentActivity: { latestTasks: Task[]; recentFailures: Task[] };
	timeSeriesData: { date: string; count: number }[];
	runningVMs: { vm_name: string; task_id: string; status: TaskStatus }[];
}

/**
 * Get dashboard metrics for a specific user
 */
export async function getDashboardMetrics(userId: string): Promise<DashboardMetrics> {
	// Helper to get single value
	const getSingleValue = async (sql: string, params: SqlValue[]): Promise<DbRow | undefined> => {
		if (isAsync) {
			return await (adapter as PostgresAdapter).get(sql, params);
		}
		return adapter.get(sql, params);
	};

	// Helper to get multiple rows
	const getMultipleRows = async (sql: string, params: SqlValue[]): Promise<DbRow[]> => {
		if (isAsync) {
			return await (adapter as PostgresAdapter).all(sql, params);
		}
		return adapter.all(sql, params) as DbRow[];
	};

	// Total and active tasks
	const totalTasksResult = (await getSingleValue(
		'SELECT COUNT(*) as count FROM tasks WHERE user_id = ?',
		[userId]
	)) as { count: number };
	const totalTasks = totalTasksResult.count;

	const activeTasksResult = (await getSingleValue(
		"SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status IN ('pending', 'provisioning', 'initializing', 'cloning', 'running')",
		[userId]
	)) as { count: number };
	const activeTasks = activeTasksResult.count;

	// Status breakdown
	const statusBreakdown = (await getMultipleRows(
		`
		SELECT status, COUNT(*) as count
		FROM tasks
		WHERE user_id = ?
		GROUP BY status
	`,
		[userId]
	)) as { status: TaskStatus; count: number }[];

	const statusBreakdownWithPercentage = statusBreakdown.map((s) => ({
		...s,
		percentage: totalTasks > 0 ? Math.round((s.count / totalTasks) * 100) : 0,
	}));

	// Agent breakdown
	const agentBreakdown = (await getMultipleRows(
		`
		SELECT coding_cli, COUNT(*) as count
		FROM tasks
		WHERE user_id = ?
		GROUP BY coding_cli
	`,
		[userId]
	)) as { coding_cli: string; count: number }[];

	const agentBreakdownWithPercentage = agentBreakdown.map((a) => ({
		...a,
		percentage: totalTasks > 0 ? Math.round((a.count / totalTasks) * 100) : 0,
	}));

	// User stats (for individual user, just show their total)
	const userStats = {
		totalUsers: 1,
		mostActiveUsers: [] as { user_email: string; task_count: number }[],
	};

	// Success metrics
	const successMetrics = (await getSingleValue(
		`
		SELECT
			SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
			SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
		FROM tasks
		WHERE user_id = ?
	`,
		[userId]
	)) as { completed: number | null; failed: number | null };

	const completed = successMetrics.completed || 0;
	const failed = successMetrics.failed || 0;
	const total = completed + failed;
	const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
	const failureRate = total > 0 ? Math.round((failed / total) * 100) : 0;

	// Recent activity
	const latestTasks = (await getMultipleRows(
		`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`,
		[userId]
	)) as unknown as Task[];

	const recentFailures = (await getMultipleRows(
		`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE user_id = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 5`,
		[userId]
	)) as unknown as Task[];

	// Time series (last 7 days)
	const timeSeriesData = (await getMultipleRows(
		`
		SELECT ${sqlBuilder.date('created_at')} as date, COUNT(*) as count
		FROM tasks
		WHERE user_id = ? AND created_at >= ${sqlBuilder.dateSubtract(7)}
		GROUP BY ${sqlBuilder.date('created_at')}
		ORDER BY date ASC
	`,
		[userId]
	)) as { date: string; count: number }[];

	// Running VMs
	const runningVMs = (await getMultipleRows(
		`
		SELECT vm_name, id as task_id, status
		FROM tasks
		WHERE user_id = ? AND vm_name IS NOT NULL AND status IN ('running', 'cloning', 'provisioning', 'initializing')
	`,
		[userId]
	)) as { vm_name: string; task_id: string; status: TaskStatus }[];

	return {
		totalTasks,
		activeTasks,
		statusBreakdown: statusBreakdownWithPercentage,
		agentBreakdown: agentBreakdownWithPercentage,
		userStats,
		successMetrics: { completed, failed, completionRate, failureRate },
		recentActivity: { latestTasks, recentFailures },
		timeSeriesData,
		runningVMs,
	};
}

/**
 * Get dashboard metrics for all users (admin only)
 */
export async function getAllDashboardMetrics(): Promise<DashboardMetrics> {
	// Helper to get single value
	const getSingleValue = async (sql: string, params: SqlValue[]): Promise<DbRow | undefined> => {
		if (isAsync) {
			return await (adapter as PostgresAdapter).get(sql, params);
		}
		return adapter.get(sql, params);
	};

	// Helper to get multiple rows
	const getMultipleRows = async (sql: string, params: SqlValue[]): Promise<DbRow[]> => {
		if (isAsync) {
			return await (adapter as PostgresAdapter).all(sql, params);
		}
		return adapter.all(sql, params) as DbRow[];
	};

	// Total and active tasks
	const totalTasksResult = (await getSingleValue('SELECT COUNT(*) as count FROM tasks', [])) as {
		count: number;
	};
	const totalTasks = totalTasksResult.count;

	const activeTasksResult = (await getSingleValue(
		"SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'provisioning', 'initializing', 'cloning', 'running')",
		[]
	)) as { count: number };
	const activeTasks = activeTasksResult.count;

	// Status breakdown
	const statusBreakdown = (await getMultipleRows(
		`
		SELECT status, COUNT(*) as count
		FROM tasks
		GROUP BY status
	`,
		[]
	)) as { status: TaskStatus; count: number }[];

	const statusBreakdownWithPercentage = statusBreakdown.map((s) => ({
		...s,
		percentage: totalTasks > 0 ? Math.round((s.count / totalTasks) * 100) : 0,
	}));

	// Agent breakdown
	const agentBreakdown = (await getMultipleRows(
		`
		SELECT coding_cli, COUNT(*) as count
		FROM tasks
		GROUP BY coding_cli
	`,
		[]
	)) as { coding_cli: string; count: number }[];

	const agentBreakdownWithPercentage = agentBreakdown.map((a) => ({
		...a,
		percentage: totalTasks > 0 ? Math.round((a.count / totalTasks) * 100) : 0,
	}));

	// User stats
	const totalUsersResult = (await getSingleValue(
		'SELECT COUNT(DISTINCT user_id) as count FROM tasks',
		[]
	)) as { count: number };
	const mostActiveUsers = (await getMultipleRows(
		`
		SELECT user_email, COUNT(*) as task_count
		FROM tasks
		GROUP BY user_email
		ORDER BY task_count DESC
		LIMIT 5
	`,
		[]
	)) as { user_email: string; task_count: number }[];

	const userStats = {
		totalUsers: totalUsersResult.count,
		mostActiveUsers,
	};

	// Success metrics
	const successMetrics = (await getSingleValue(
		`
		SELECT
			SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
			SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
		FROM tasks
	`,
		[]
	)) as { completed: number | null; failed: number | null };

	const completed = successMetrics.completed || 0;
	const failed = successMetrics.failed || 0;
	const total = completed + failed;
	const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
	const failureRate = total > 0 ? Math.round((failed / total) * 100) : 0;

	// Recent activity
	const latestTasks = (await getMultipleRows(
		`SELECT ${TASK_LIST_COLUMNS} FROM tasks ORDER BY created_at DESC LIMIT 10`,
		[]
	)) as unknown as Task[];

	const recentFailures = (await getMultipleRows(
		`SELECT ${TASK_LIST_COLUMNS} FROM tasks WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 10`,
		[]
	)) as unknown as Task[];

	// Time series (last 7 days)
	const timeSeriesData = (await getMultipleRows(
		`
		SELECT ${sqlBuilder.date('created_at')} as date, COUNT(*) as count
		FROM tasks
		WHERE created_at >= ${sqlBuilder.dateSubtract(7)}
		GROUP BY ${sqlBuilder.date('created_at')}
		ORDER BY date ASC
	`,
		[]
	)) as { date: string; count: number }[];

	// Running VMs
	const runningVMs = (await getMultipleRows(
		`
		SELECT vm_name, id as task_id, status
		FROM tasks
		WHERE vm_name IS NOT NULL AND status IN ('running', 'cloning', 'provisioning', 'initializing')
	`,
		[]
	)) as { vm_name: string; task_id: string; status: TaskStatus }[];

	return {
		totalTasks,
		activeTasks,
		statusBreakdown: statusBreakdownWithPercentage,
		agentBreakdown: agentBreakdownWithPercentage,
		userStats,
		successMetrics: { completed, failed, completionRate, failureRate },
		recentActivity: { latestTasks, recentFailures },
		timeSeriesData,
		runningVMs,
	};
}

/**
 * Update metadata JSON field for a task
 */
export async function updateTaskMetadata(
	id: string,
	updates: Partial<TaskMetadata>
): Promise<void> {
	// Get current task to merge metadata
	const task = await getTaskById(id);
	if (!task) return;

	const currentMetadata = task.metadata || {};
	const newMetadata = { ...currentMetadata, ...updates };

	// Deep merge for nested objects like linear
	if (updates.linear && currentMetadata.linear) {
		newMetadata.linear = { ...currentMetadata.linear, ...updates.linear };
	}

	const sql = `UPDATE tasks SET metadata = ?, updated_at = ${sqlBuilder.now()} WHERE id = ?`;
	const metadataStr = JSON.stringify(newMetadata);

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, [metadataStr, id]);
	} else {
		adapter.run(sql, [metadataStr, id]);
	}
}

/**
 * Mark that connection commands have been posted for a task (Linear integration)
 */
export async function markConnectionCommandsPosted(id: string): Promise<void> {
	const task = await getTaskById(id);
	if (!task?.metadata?.linear) return;

	await updateTaskMetadata(id, {
		linear: {
			...task.metadata.linear,
			connection_commands_posted: true,
		},
	});
}

/**
 * Mark that attention check has been posted for a task (Linear integration)
 */
export async function markAttentionCheckPosted(id: string): Promise<void> {
	const task = await getTaskById(id);
	if (!task?.metadata?.linear) return;

	await updateTaskMetadata(id, {
		linear: {
			...task.metadata.linear,
			attention_check_posted: true,
		},
	});
}

/**
 * ============================================================================
 * Configuration Management Functions
 * ============================================================================
 */

/**
 * Get all configuration values
 */
export async function getAllConfig(): Promise<Array<import('./schema').Config>> {
	const sql = 'SELECT * FROM config ORDER BY category, key';

	if (isAsync) {
		const rows = await (adapter as PostgresAdapter).all(sql, []);
		return rows.map((row) => ({
			...row,
			is_secret: dbConfig.type === 'postgres' ? row.is_secret : row.is_secret === 1,
		})) as Array<import('./schema').Config>;
	} else {
		const rows = (adapter as SqliteAdapter).all(sql, []);
		return rows.map((row) => ({
			...row,
			is_secret: row.is_secret === 1,
		})) as Array<import('./schema').Config>;
	}
}

/**
 * Get a configuration value by key
 */
export async function getConfigByKey(key: string): Promise<import('./schema').Config | null> {
	const sql = 'SELECT * FROM config WHERE key = ?';

	if (isAsync) {
		const row = await (adapter as PostgresAdapter).get(sql, [key]);
		if (!row) return null;
		return {
			...row,
			is_secret: row.is_secret,
		} as import('./schema').Config;
	} else {
		const row = (adapter as SqliteAdapter).get(sql, [key]);
		if (!row) return null;
		return {
			...row,
			is_secret: row.is_secret === 1,
		} as import('./schema').Config;
	}
}

/**
 * Set or update a configuration value
 */
export async function setConfig(input: import('./schema').ConfigCreateInput): Promise<void> {
	const now = sqlBuilder.now();
	const isSecretValue =
		dbConfig.type === 'postgres' ? (input.is_secret ?? false) : input.is_secret ? 1 : 0;

	// Check if key exists first
	const existing = await getConfigByKey(input.key);

	if (existing) {
		// Update existing
		const updateSql = `
			UPDATE config
			SET value = ?, description = ?, is_secret = ?, category = ?, updated_at = ${now}
			WHERE key = ?
		`;
		const updateParams = [
			input.value,
			input.description ?? null,
			isSecretValue,
			input.category ?? null,
			input.key,
		];

		if (isAsync) {
			await (adapter as PostgresAdapter).run(updateSql, updateParams);
		} else {
			adapter.run(updateSql, updateParams);
		}
	} else {
		// Insert new
		const insertSql = `
			INSERT INTO config (key, value, description, is_secret, category, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ${now}, ${now})
		`;
		const insertParams = [
			input.key,
			input.value,
			input.description ?? null,
			isSecretValue,
			input.category ?? null,
		];

		if (isAsync) {
			await (adapter as PostgresAdapter).run(insertSql, insertParams);
		} else {
			adapter.run(insertSql, insertParams);
		}
	}
}

/**
 * Delete a configuration value
 */
export async function deleteConfig(key: string): Promise<void> {
	const sql = 'DELETE FROM config WHERE key = ?';

	if (isAsync) {
		await (adapter as PostgresAdapter).run(sql, [key]);
	} else {
		adapter.run(sql, [key]);
	}
}

export type {
	Config,
	ConfigCreateInput,
	ConfigUpdateInput,
	Task,
	TaskCreateInput,
	TaskMetadata,
	TaskStatus,
} from './schema';
