import { AuthTypes, Connector } from '@google-cloud/cloud-sql-connector';
import pg from 'pg';
import type { DbAdapter, DbRow, SqlValue } from './adapter';

const { Pool } = pg;

/** Errors that indicate a connection drop and should trigger a retry */
const RETRIABLE_ERRORS = [
	'Connection terminated unexpectedly',
	'Connection terminated',
	'Client network socket disconnected',
	'connection terminated',
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'57P01', // admin_shutdown
	'57P02', // crash_shutdown
	'57P03', // cannot_connect_now
	'08000', // connection_exception
	'08003', // connection_does_not_exist
	'08006', // connection_failure
];

/** Check if an error is retriable */
function isRetriableError(error: unknown): boolean {
	if (!error) return false;
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: string }).code;
	return RETRIABLE_ERRORS.some((e) => message.includes(e) || code === e);
}

/** Sleep for a given number of milliseconds */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * PostgreSQL database adapter with CloudSQL support
 * Supports both standard PostgreSQL connections and CloudSQL Unix socket connections with IAM auth
 */
export class PostgresAdapter implements DbAdapter {
	private pool: pg.Pool;
	private connector?: Connector;
	private poolConfig: pg.PoolConfig;
	private static readonly MAX_RETRIES = 3;
	private static readonly BASE_DELAY_MS = 100;

	constructor(config: pg.PoolConfig, connector?: Connector) {
		this.poolConfig = config;
		this.pool = new Pool(config);
		this.connector = connector;
		this.setupPoolErrorHandler();
	}

	/** Set up error handler for the pool to log connection issues */
	private setupPoolErrorHandler(): void {
		this.pool.on('error', (err) => {
			console.error('[PostgresAdapter] Pool error:', err.message);
			// Don't crash on idle client errors - the retry logic will handle reconnection
		});
	}

	/** Recreate the connection pool after fatal errors */
	private async recreatePool(): Promise<void> {
		console.log('[PostgresAdapter] Recreating connection pool...');
		try {
			await this.pool.end();
		} catch {
			// Ignore errors when ending a broken pool
		}
		this.pool = new Pool(this.poolConfig);
		this.setupPoolErrorHandler();
		console.log('[PostgresAdapter] Connection pool recreated');
	}

	/** Execute an operation with retry logic for connection drops */
	private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
		let lastError: unknown;

		for (let attempt = 1; attempt <= PostgresAdapter.MAX_RETRIES; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error;

				if (!isRetriableError(error)) {
					throw error;
				}

				console.warn(
					`[PostgresAdapter] ${operationName} failed (attempt ${attempt}/${PostgresAdapter.MAX_RETRIES}):`,
					error instanceof Error ? error.message : error
				);

				if (attempt < PostgresAdapter.MAX_RETRIES) {
					// Exponential backoff: 100ms, 200ms, 400ms...
					const delay = PostgresAdapter.BASE_DELAY_MS * 2 ** (attempt - 1);
					await sleep(delay);

					// On second retry, recreate the pool in case it's completely dead
					if (attempt === 2) {
						await this.recreatePool();
					}
				}
			}
		}

		throw lastError;
	}

	/**
	 * Create adapter from connection string
	 * Supports standard postgresql:// URLs and CloudSQL with IAM authentication
	 */
	static async fromConnectionString(connectionString: string): Promise<PostgresAdapter> {
		// Check if this is IAM authentication
		const isIAMAuth = connectionString.includes('reindeer-vibe.iam');

		if (isIAMAuth) {
			// Cloud SQL Connector + IAM auth (both production and local dev)
			const url = new URL(connectionString.replace('postgresql://', 'postgres://'));
			const username = decodeURIComponent(url.username);
			const database = url.pathname.slice(1);

			// Get instance connection name from env var
			const instanceConnectionName = process.env.CLOUDSQL_INSTANCE || '';

			if (!instanceConnectionName) {
				throw new Error(
					'CloudSQL instance connection name required for IAM auth. ' +
						'Set CLOUDSQL_INSTANCE env var.'
				);
			}

			const NODE_ENV = process.env.NODE_ENV || 'development';
			let connector: Connector;

			if (NODE_ENV !== 'production') {
				// Local dev: use impersonated credentials via Cloud SQL Connector
				const { GoogleAuth, Impersonated } = await import('google-auth-library');
				const sourceAuth = new GoogleAuth({
					scopes: ['https://www.googleapis.com/auth/cloud-platform'],
				});
				const sourceClient = await sourceAuth.getClient();
				const targetSA = username + '.gserviceaccount.com';

				console.log('[db] Local dev: Connecting with Cloud SQL Connector + IAM auth (impersonation)');
				console.log(`[db]   Instance: ${instanceConnectionName}`);
				console.log(`[db]   User: ${username}`);
				console.log(`[db]   Target SA: ${targetSA}`);
				console.log(`[db]   Database: ${database}`);

				const impersonatedClient = new Impersonated({
					sourceClient,
					targetPrincipal: targetSA,
					targetScopes: ['https://www.googleapis.com/auth/cloud-platform'],
					lifetime: 3600,
				});

				connector = new Connector({ auth: impersonatedClient });
			} else {
				// Production: Cloud Run with workload identity (ADC)
				console.log('[db] Production: Connecting with Cloud SQL Connector + IAM auth');
				console.log(`[db]   Instance: ${instanceConnectionName}`);
				console.log(`[db]   User: ${username}`);
				console.log(`[db]   Database: ${database}`);

				connector = new Connector();
			}

			const clientOpts = await connector.getOptions({
				instanceConnectionName,
				authType: AuthTypes.IAM,
			});

			const config: pg.PoolConfig = {
				...clientOpts,
				user: username,
				database,
			};

			return new PostgresAdapter(config, connector);
		}


		// Standard PostgreSQL connection string (non-IAM)
		return new PostgresAdapter({
			connectionString,
		});
	}

	async exec(sql: string): Promise<void> {
		return this.withRetry(async () => {
			const client = await this.pool.connect();
			try {
				await client.query(sql);
			} finally {
				client.release();
			}
		}, 'exec');
	}

	async get(sql: string, params: SqlValue[]): Promise<DbRow | undefined> {
		return this.withRetry(async () => {
			const client = await this.pool.connect();
			try {
				const result = await client.query(this.convertPlaceholders(sql), params);
				return result.rows[0];
			} finally {
				client.release();
			}
		}, 'get');
	}

	async all(sql: string, params: SqlValue[]): Promise<DbRow[]> {
		return this.withRetry(async () => {
			const client = await this.pool.connect();
			try {
				const result = await client.query(this.convertPlaceholders(sql), params);
				return result.rows;
			} finally {
				client.release();
			}
		}, 'all');
	}

	async run(sql: string, params: SqlValue[]): Promise<void> {
		return this.withRetry(async () => {
			const client = await this.pool.connect();
			try {
				await client.query(this.convertPlaceholders(sql), params);
			} finally {
				client.release();
			}
		}, 'run');
	}

	async hasColumn(tableName: string, columnName: string): Promise<boolean> {
		return this.withRetry(async () => {
			const client = await this.pool.connect();
			try {
				const result = await client.query(
					`SELECT column_name
					 FROM information_schema.columns
					 WHERE table_name = $1 AND column_name = $2`,
					[tableName, columnName]
				);
				return result.rows.length > 0;
			} catch (error) {
				// Re-throw retriable errors so they get retried
				if (isRetriableError(error)) {
					throw error;
				}
				return false;
			} finally {
				client.release();
			}
		}, 'hasColumn');
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
