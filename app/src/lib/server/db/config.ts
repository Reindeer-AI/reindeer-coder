import type { DbAdapter } from './adapter';
import { PostgresAdapter } from './postgres-adapter';
import { SqliteAdapter } from './sqlite-adapter';

export type DatabaseType = 'sqlite' | 'postgres';

export interface DatabaseConfig {
	type: DatabaseType;
	// SQLite config
	filename?: string;
	// PostgreSQL config
	connectionString?: string;
	host?: string;
	port?: number;
	database?: string;
	user?: string;
	password?: string;
}

/**
 * Create a database adapter based on the configuration
 */
export async function createAdapter(config: DatabaseConfig): Promise<DbAdapter> {
	if (config.type === 'sqlite') {
		const filename = config.filename || 'vibe-coding.db';
		console.log(`[db] Using SQLite database: ${filename}`);
		return new SqliteAdapter(filename);
	}

	if (config.type === 'postgres') {
		console.log('[db] Using PostgreSQL database');

		if (config.connectionString) {
			return await PostgresAdapter.fromConnectionString(config.connectionString);
		}

		return new PostgresAdapter({
			host: config.host,
			port: config.port || 5432,
			database: config.database || 'vibe_coding',
			user: config.user,
			password: config.password,
		});
	}

	throw new Error(`Unsupported database type: ${config.type}`);
}

/**
 * Get database configuration from environment variables
 */
export function getDatabaseConfigFromEnv(): DatabaseConfig {
	const dbType = (process.env.DB_TYPE || 'sqlite') as DatabaseType;

	if (dbType === 'sqlite') {
		return {
			type: 'sqlite',
			filename: process.env.DB_FILENAME || 'vibe-coding.db',
		};
	}

	if (dbType === 'postgres') {
		// Support connection string or individual parameters
		const connectionString = process.env.DATABASE_URL || process.env.DB_CONNECTION_STRING;

		if (connectionString) {
			return {
				type: 'postgres',
				connectionString,
			};
		}

		return {
			type: 'postgres',
			host: process.env.DB_HOST || 'localhost',
			port: parseInt(process.env.DB_PORT || '5432', 10),
			database: process.env.DB_NAME || 'vibe_coding',
			user: process.env.DB_USER || 'postgres',
			password: process.env.DB_PASSWORD,
		};
	}

	throw new Error(`Invalid DB_TYPE: ${dbType}. Must be 'sqlite' or 'postgres'.`);
}
