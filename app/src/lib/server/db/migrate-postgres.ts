/**
 * PostgreSQL migration script
 * Run this to create the initial database schema in PostgreSQL
 *
 * Usage:
 *   node --loader ts-node/esm src/lib/server/db/migrate-postgres.ts
 */

import { PostgresAdapter } from './postgres-adapter.js';

async function migrate() {
	console.log('[migrate] Starting PostgreSQL migration...');

	// Get database configuration from environment
	const connectionString = process.env.DATABASE_URL || process.env.DB_CONNECTION_STRING;
	const host = process.env.DB_HOST;
	const port = parseInt(process.env.DB_PORT || '5432', 10);
	const database = process.env.DB_NAME || 'vibe_coding';
	const user = process.env.DB_USER;
	const password = process.env.DB_PASSWORD;

	let adapter: PostgresAdapter;

	if (connectionString) {
		console.log('[migrate] Using connection string');
		adapter = await PostgresAdapter.fromConnectionString(connectionString);
	} else if (host && user) {
		console.log(`[migrate] Connecting to ${host}:${port}/${database}`);
		adapter = new PostgresAdapter({
			host,
			port,
			database,
			user,
			password,
		});
	} else {
		console.error('[migrate] Database configuration not found in environment variables');
		console.error(
			'[migrate] Please set DATABASE_URL or DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD'
		);
		process.exit(1);
	}

	try {
		// Create tasks table
		console.log('[migrate] Creating tasks table...');
		await adapter.exec(`
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
				terminal_file_path TEXT,
				mr_iid INTEGER,
				mr_url TEXT,
				project_id TEXT,
				mr_last_review_sha TEXT,
				metadata JSONB,
				vm_external_ip TEXT,
				vm_zone TEXT,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`);

		console.log('[migrate] ✓ Tasks table created successfully');

		// Create indexes for better query performance
		console.log('[migrate] Creating indexes...');

		await adapter.exec(`
			CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)
		`);

		await adapter.exec(`
			CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)
		`);

		await adapter.exec(`
			CREATE INDEX IF NOT EXISTS idx_tasks_mr_iid ON tasks(mr_iid)
		`);

		await adapter.exec(`
			CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)
		`);

		console.log('[migrate] ✓ Indexes created successfully');

		// Create a trigger to auto-update updated_at timestamp
		console.log('[migrate] Creating triggers...');

		await adapter.exec(`
			CREATE OR REPLACE FUNCTION update_updated_at_column()
			RETURNS TRIGGER AS $$
			BEGIN
				NEW.updated_at = CURRENT_TIMESTAMP;
				RETURN NEW;
			END;
			$$ language 'plpgsql'
		`);

		await adapter.exec(`
			DROP TRIGGER IF EXISTS update_tasks_updated_at ON tasks
		`);

		await adapter.exec(`
			CREATE TRIGGER update_tasks_updated_at
			BEFORE UPDATE ON tasks
			FOR EACH ROW
			EXECUTE FUNCTION update_updated_at_column()
		`);

		console.log('[migrate] ✓ Triggers created successfully');

		console.log('[migrate] ✅ Migration completed successfully!');
		process.exit(0);
	} catch (error) {
		console.error('[migrate] ❌ Migration failed:', error);
		process.exit(1);
	} finally {
		await adapter.close();
	}
}

migrate();
