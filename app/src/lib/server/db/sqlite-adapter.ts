import Database from 'better-sqlite3';
import type { DbAdapter, DbRow, SqlValue } from './adapter';

interface PragmaColumnInfo {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}

/**
 * SQLite database adapter using better-sqlite3
 */
export class SqliteAdapter implements DbAdapter {
	private db: Database.Database;

	constructor(filename: string) {
		this.db = new Database(filename);
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	get(sql: string, params: SqlValue[]): DbRow | undefined {
		const stmt = this.db.prepare(sql);
		return stmt.get(...params) as DbRow | undefined;
	}

	all(sql: string, params: SqlValue[]): DbRow[] {
		const stmt = this.db.prepare(sql);
		return stmt.all(...params) as DbRow[];
	}

	run(sql: string, params: SqlValue[]): void {
		const stmt = this.db.prepare(sql);
		stmt.run(...params);
	}

	async hasColumn(tableName: string, columnName: string): Promise<boolean> {
		try {
			const result = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as PragmaColumnInfo[];
			return result.some((col) => col.name === columnName);
		} catch {
			return false;
		}
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Get the underlying better-sqlite3 database instance
	 * Useful for direct access to SQLite-specific features
	 */
	getDb(): Database.Database {
		return this.db;
	}
}
