/**
 * Database adapter interface for supporting multiple database backends
 * Supports both SQLite and PostgreSQL
 */

/** SQL parameter types supported by both SQLite and PostgreSQL */
export type SqlValue = string | number | boolean | null | Buffer;

/** Generic database row - column values can be any SQL type */
export type DbRow = Record<string, SqlValue>;

export interface DbAdapter {
	/**
	 * Execute a SQL statement (DDL, DML without results)
	 * Can be sync (SQLite) or async (PostgreSQL)
	 */
	exec(sql: string): void | Promise<void>;

	/**
	 * Prepare and execute a query that returns a single row
	 * Can be sync (SQLite) or async (PostgreSQL)
	 */
	get(sql: string, params: SqlValue[]): DbRow | undefined | Promise<DbRow | undefined>;

	/**
	 * Prepare and execute a query that returns multiple rows
	 * Can be sync (SQLite) or async (PostgreSQL)
	 */
	all(sql: string, params: SqlValue[]): DbRow[] | Promise<DbRow[]>;

	/**
	 * Execute an insert/update/delete and return the number of affected rows
	 * Can be sync (SQLite) or async (PostgreSQL)
	 */
	run(sql: string, params: SqlValue[]): void | Promise<void>;

	/**
	 * Check if a column exists in a table
	 */
	hasColumn(tableName: string, columnName: string): Promise<boolean>;

	/**
	 * Close the database connection
	 * Can be sync (SQLite) or async (PostgreSQL)
	 */
	close(): void | Promise<void>;
}

/**
 * Represents a prepared statement result for SQLite
 */
export interface PreparedStatement {
	get(params: SqlValue[]): DbRow | undefined;
	all(params: SqlValue[]): DbRow[];
	run(...params: SqlValue[]): void;
}
