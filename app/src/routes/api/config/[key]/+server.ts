import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { deleteConfig, getConfigByKey } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * GET /api/config/:key
 * Get a specific configuration value (admin only)
 */
export const GET: RequestHandler = async ({ params, request }) => {
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
		const config = await getConfigByKey(params.key);
		if (!config) {
			throw error(404, 'Configuration not found');
		}

		// Mask secret values
		if (config.is_secret) {
			config.value = '[REDACTED]';
		}

		return json({ config });
	} catch (err) {
		console.error('[api/config/:key] Error fetching config:', err);
		if (err instanceof Error && 'status' in err) throw err;
		throw error(500, 'Failed to fetch configuration');
	}
};

/**
 * DELETE /api/config/:key
 * Delete a configuration value (admin only)
 */
export const DELETE: RequestHandler = async ({ params, request }) => {
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
		await deleteConfig(params.key);

		// Reload config cache
		await configService.reload();

		return json({ success: true, message: 'Configuration deleted' });
	} catch (err) {
		console.error('[api/config/:key] Error deleting config:', err);
		if (err instanceof Error && 'status' in err) throw err;
		throw error(500, 'Failed to delete configuration');
	}
};
