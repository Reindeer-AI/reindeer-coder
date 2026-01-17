import { AuthTypes, Connector } from '@google-cloud/cloud-sql-connector';
import pg from 'pg';
import type { DbAdapter, DbRow, SqlValue } from './adapter';

const { Pool } = pg;

/**
 * PostgreSQL database adapter with CloudSQL support
 * Supports both standard PostgreSQL connections and CloudSQL Unix socket connections with IAM auth
 */
export class PostgresAdapter implements DbAdapter {
	private pool: pg.Pool;
	private connector?: Connector;

	constructor(config: pg.PoolConfig, connector?: Connector) {
		this.pool = new Pool(config);
		this.connector = connector;
	}

	/**
	 * Create adapter from connection string
	 * Supports standard postgresql:// URLs and CloudSQL unix socket paths with IAM authentication
	 */
	static async fromConnectionString(connectionString: string): Promise<PostgresAdapter> {
		// Check if this is a CloudSQL unix socket connection
		// Format: /cloudsql/PROJECT:REGION:INSTANCE or unix socket path
		if (connectionString.startsWith('/cloudsql/')) {
			// Extract instance connection name from path
			// Format: /cloudsql/PROJECT:REGION:INSTANCE
			const instanceConnectionName = connectionString.replace('/cloudsql/', '');

			// Use Cloud SQL Connector for IAM authentication
			const connector = new Connector();
			const clientOpts = await connector.getOptions({
				instanceConnectionName,
				authType: AuthTypes.IAM,
			});

			const config: pg.PoolConfig = {
				...clientOpts,
				database: process.env.DB_NAME || 'vibe_coding',
				user: process.env.DB_USER,
			};

			return new PostgresAdapter(config, connector);
		}

		// Standard PostgreSQL connection string
		return new PostgresAdapter({
			connectionString,
		});
	}

	async exec(sql: string): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query(sql);
		} finally {
			client.release();
		}
	}

	async get(sql: string, params: SqlValue[]): Promise<DbRow | undefined> {
		const client = await this.pool.connect();
		try {
			const result = await client.query(this.convertPlaceholders(sql), params);
			return result.rows[0];
		} finally {
			client.release();
		}
	}

	async all(sql: string, params: SqlValue[]): Promise<DbRow[]> {
		const client = await this.pool.connect();
		try {
			const result = await client.query(this.convertPlaceholders(sql), params);
			return result.rows;
		} finally {
			client.release();
		}
	}

	async run(sql: string, params: SqlValue[]): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query(this.convertPlaceholders(sql), params);
		} finally {
			client.release();
		}
	}

	async hasColumn(tableName: string, columnName: string): Promise<boolean> {
		const client = await this.pool.connect();
		try {
			const result = await client.query(
				`SELECT column_name
				 FROM information_schema.columns
				 WHERE table_name = $1 AND column_name = $2`,
				[tableName, columnName]
			);
			return result.rows.length > 0;
		} catch {
			return false;
		} finally {
			client.release();
		}
	}

	async close(): Promise<void> {
		await this.pool.end();
		if (this.connector) {
			this.connector.close();
		}
	}

	/**
	 * Convert SQLite-style ? placeholders to PostgreSQL-style $1, $2, etc.
	 */
	private convertPlaceholders(sql: string): string {
		let index = 1;
		return sql.replace(/\?/g, () => `$${index++}`);
	}

	/**
	 * Get the underlying pg.Pool instance
	 * Useful for direct access to PostgreSQL-specific features
	 */
	getPool(): pg.Pool {
		return this.pool;
	}
}

/**
 * Synchronous wrapper for PostgreSQL adapter
 * Provides compatibility with synchronous SQLite API
 */
export class PostgresAdapterSync implements DbAdapter {
	private adapter: PostgresAdapter;

	constructor(adapter: PostgresAdapter) {
		this.adapter = adapter;
	}

	exec(sql: string): void {
		// Execute asynchronously but don't wait for completion
		// This is primarily for initialization where we can't use await
		this.adapter.exec(sql).catch((error) => {
			console.error('[PostgresAdapterSync] Error executing SQL:', error);
		});
	}

	get(_sql: string, _params: SqlValue[]): DbRow | undefined {
		throw new Error('Synchronous get() not supported for PostgreSQL. Use async version.');
	}

	all(_sql: string, _params: SqlValue[]): DbRow[] {
		throw new Error('Synchronous all() not supported for PostgreSQL. Use async version.');
	}

	run(sql: string, params: SqlValue[]): void {
		// Execute asynchronously but don't wait for completion
		this.adapter.run(sql, params).catch((error) => {
			console.error('[PostgresAdapterSync] Error running SQL:', error);
		});
	}

	async hasColumn(tableName: string, columnName: string): Promise<boolean> {
		return this.adapter.hasColumn(tableName, columnName);
	}

	close(): void {
		this.adapter.close().catch((error) => {
			console.error('[PostgresAdapterSync] Error closing connection:', error);
		});
	}

	/**
	 * Get the underlying PostgresAdapter for async operations
	 */
	getAdapter(): PostgresAdapter {
		return this.adapter;
	}
}
