import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import type { RequestHandler } from './$types';

/**
 * GET /api/config
 * Get all configuration values (admin only)
 */
export const GET: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	// Check admin permission
	const adminPermission = await configService.get(
		'auth.admin_permission',
		'admin',
		'ADMIN_PERMISSION'
	);
	const isAdmin = user.permissions.includes(adminPermission);
	if (!isAdmin) {
		throw error(403, 'Access denied - admin only');
	}

	try {
		// Get all config with secrets masked for display
		const configs = await configService.getAllForDisplay();
		return json({ configs });
	} catch (err) {
		console.error('[api/config] Error fetching config:', err);
		throw error(500, 'Failed to fetch configuration');
	}
};

/**
 * POST /api/config
 * Create or update a configuration value (admin only)
 */
export const POST: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	// Check admin permission
	const adminPermission = await configService.get(
		'auth.admin_permission',
		'admin',
		'ADMIN_PERMISSION'
	);
	const isAdmin = user.permissions.includes(adminPermission);
	if (!isAdmin) {
		throw error(403, 'Access denied - admin only');
	}

	try {
		const body = await request.json();
		const { key, value, description, is_secret, category } = body;

		if (!key || value === undefined) {
			throw error(400, 'Missing required fields: key, value');
		}

		// Validate key format (alphanumeric, dots, and underscores only)
		if (!/^[a-zA-Z0-9._]+$/.test(key)) {
			throw error(
				400,
				'Invalid key format. Use only alphanumeric characters, dots, and underscores.'
			);
		}

		await configService.set(key, value, description, is_secret, category);

		// Reload config cache
		await configService.reload();

		return json({ success: true, message: 'Configuration updated' });
	} catch (err) {
		console.error('[api/config] Error updating config:', err);
		if (err instanceof Error && 'status' in err) throw err;
		throw error(500, 'Failed to update configuration');
	}
};
