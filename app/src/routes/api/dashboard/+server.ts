import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyToken, extractBearerToken } from '$lib/server/auth';
import { getDashboardMetrics, getAllDashboardMetrics } from '$lib/server/db';
import { configService } from '$lib/server/config-service';

// GET /api/dashboard - Get dashboard metrics
export const GET: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token);
	if (!user) {
		throw error(401, 'Invalid token');
	}

	// Admins see all metrics, regular users see their own
	const adminPermission = await configService.get('auth.admin_permission', 'admin', 'ADMIN_PERMISSION');
	const isAdmin = user.permissions.includes(adminPermission);
	const metrics = isAdmin ? await getAllDashboardMetrics() : await getDashboardMetrics(user.sub);

	return json({ metrics, isAdmin });
};
