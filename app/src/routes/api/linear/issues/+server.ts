import { error, json } from '@sveltejs/kit';
import { extractBearerToken, isAuthDisabled, verifyToken } from '$lib/server/auth';
import { getLinearApiKey } from '$lib/server/secrets';
import type { RequestHandler } from './$types';

interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	state: {
		name: string;
		color: string;
	};
	priority: number;
	estimate: number | null;
	labels: {
		nodes: Array<{
			name: string;
			color: string;
		}>;
	};
	assignee: {
		name: string;
		email: string;
	} | null;
	project: {
		name: string;
	} | null;
	url: string;
}

// GET /api/linear/issues - Fetch Linear issues
export const GET: RequestHandler = async ({ request }) => {
	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token && !isAuthDisabled()) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token || '');
	if (!user) {
		throw error(401, 'Invalid token');
	}

	let linearApiKey: string;
	try {
		linearApiKey = await getLinearApiKey();
	} catch (err) {
		console.error('Failed to get Linear API key:', err);
		throw error(500, 'Linear API key not configured');
	}

	try {
		// Fetch issues from Linear GraphQL API
		const response = await fetch('https://api.linear.app/graphql', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: linearApiKey,
			},
			body: JSON.stringify({
				query: `
					query {
						issues(
							first: 100
							filter: {
								state: { type: { nin: ["completed", "canceled"] } }
							}
							orderBy: updatedAt
						) {
							nodes {
								id
								identifier
								title
								description
								state {
									name
									color
								}
								priority
								estimate
								labels {
									nodes {
										name
										color
									}
								}
								assignee {
									name
									email
								}
								project {
									name
								}
								url
							}
						}
					}
				`,
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			console.error('Linear API error:', text);
			throw error(500, 'Failed to fetch Linear issues');
		}

		const data = await response.json();

		if (data.errors) {
			console.error('Linear GraphQL errors:', data.errors);
			throw error(500, 'Linear API returned errors');
		}

		const issues: LinearIssue[] = data.data?.issues?.nodes || [];

		return json({ issues });
	} catch (err) {
		console.error('Error fetching Linear issues:', err);
		if (err instanceof Error && 'status' in err) {
			throw err;
		}
		throw error(500, 'Failed to fetch Linear issues');
	}
};
