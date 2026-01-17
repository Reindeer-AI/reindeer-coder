import Database from 'better-sqlite3';
import type { DbAdapter, DbRow } from './adapter';

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

	get(sql: string, params: any[]): DbRow | undefined {
		const stmt = this.db.prepare(sql);
		return stmt.get(...params) as DbRow | undefined;
	}

	all(sql: string, params: any[]): DbRow[] {
		const stmt = this.db.prepare(sql);
		return stmt.all(...params) as DbRow[];
	}

	run(sql: string, params: any[]): void {
		const stmt = this.db.prepare(sql);
		stmt.run(...params);
	}

	async hasColumn(tableName: string, columnName: string): Promise<boolean> {
		try {
			const result = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as any[];
			return result.some((col: any) => col.name === columnName);
		} catch (error) {
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
