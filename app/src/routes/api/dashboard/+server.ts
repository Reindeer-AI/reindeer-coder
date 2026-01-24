import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { configService } from '$lib/server/config-service';
import { getAllDashboardMetrics, getDashboardMetrics } from '$lib/server/db';
import type { RequestHandler } from './$types';

// GET /api/dashboard - Get dashboard metrics
export const GET: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	// Admins see all metrics, regular users see their own
	const adminPermission = await configService.get(
		'auth.admin_permission',
		'admin',
		'ADMIN_PERMISSION'
	);
	const isAdmin = user.permissions.includes(adminPermission);
	const metrics = isAdmin ? await getAllDashboardMetrics() : await getDashboardMetrics(user.sub);

	return json({ metrics, isAdmin });
};
