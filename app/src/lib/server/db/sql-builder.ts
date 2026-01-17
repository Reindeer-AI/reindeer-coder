import type { DatabaseType } from './config';

/**
 * SQL builder utilities for generating database-specific SQL
 */
export class SqlBuilder {
	constructor(private dbType: DatabaseType) {}

	/**
	 * Get the current timestamp expression
	 * SQLite: datetime('now')
	 * PostgreSQL: CURRENT_TIMESTAMP
	 */
	now(): string {
		return this.dbType === 'sqlite' ? "datetime('now')" : 'CURRENT_TIMESTAMP';
	}

	/**
	 * Get date subtraction expression
	 * SQLite: DATE('now', '-7 days')
	 * PostgreSQL: CURRENT_DATE - INTERVAL '7 days'
	 */
	dateSubtract(days: number): string {
		if (this.dbType === 'sqlite') {
			return `DATE('now', '-${days} days')`;
		}
		return `CURRENT_DATE - INTERVAL '${days} days'`;
	}

	/**
	 * Get DATE() function
	 * SQLite: DATE(column)
	 * PostgreSQL: column::date
	 */
	date(column: string): string {
		return this.dbType === 'sqlite' ? `DATE(${column})` : `${column}::date`;
	}

	/**
	 * Generate ALTER TABLE ADD COLUMN statement with IF NOT EXISTS check
	 * SQLite: Try/catch duplicate column error
	 * PostgreSQL: ALTER TABLE ... ADD COLUMN IF NOT EXISTS
	 */
	addColumnIfNotExists(tableName: string, columnName: string, columnType: string): string {
		if (this.dbType === 'postgres') {
			return `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}`;
		}
		return `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`;
	}

	/**
	 * Convert data type from SQLite to PostgreSQL
	 */
	convertDataType(sqliteType: string): string {
		if (this.dbType === 'sqlite') {
			return sqliteType;
		}

		// PostgreSQL type mappings
		const typeMap: { [key: string]: string } = {
			TEXT: 'TEXT',
			INTEGER: 'INTEGER',
			REAL: 'REAL',
			BLOB: 'BYTEA',
		};

		return typeMap[sqliteType.toUpperCase()] || sqliteType;
	}

	/**
	 * Get table creation SQL with proper data types
	 */
	getCreateTableSql(): string {
		if (this.dbType === 'sqlite') {
			return `
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
				);
				CREATE TABLE IF NOT EXISTS config (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL,
					description TEXT,
					is_secret INTEGER NOT NULL DEFAULT 0,
					category TEXT,
					created_at TEXT NOT NULL DEFAULT (datetime('now')),
					updated_at TEXT NOT NULL DEFAULT (datetime('now'))
				)
			`;
		}

		// PostgreSQL
		return `
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
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			);
			CREATE TABLE IF NOT EXISTS config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				description TEXT,
				is_secret BOOLEAN NOT NULL DEFAULT FALSE,
				category TEXT,
				created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
			)
		`;
	}
}
