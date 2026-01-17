import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { extractBearerToken, verifyToken } from '$lib/server/auth';
import type { RequestHandler } from './$types';

interface LinearComment {
	id: string;
	body: string;
	createdAt: string;
	user: {
		name: string;
		email: string;
	} | null;
}

interface LinearIssueWithComments {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	url: string;
	comments: {
		nodes: LinearComment[];
	};
}

// GET /api/linear/issues/:issueId - Fetch specific Linear issue with comments
export const GET: RequestHandler = async ({ request, params }) => {
	const issueId = params.issueId;

	const token = extractBearerToken(request.headers.get('Authorization'));
	if (!token) {
		throw error(401, 'Missing authorization token');
	}

	const user = await verifyToken(token);
	if (!user) {
		throw error(401, 'Invalid token');
	}

	const linearApiKey = env.LINEAR_API_KEY;
	if (!linearApiKey) {
		throw error(500, 'Linear API key not configured');
	}

	try {
		const response = await fetch('https://api.linear.app/graphql', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: linearApiKey,
			},
			body: JSON.stringify({
				query: `
					query GetIssueWithComments($id: String!) {
						issue(id: $id) {
							id
							identifier
							title
							description
							url
							comments {
								nodes {
									id
									body
									createdAt
									user {
										name
										email
									}
								}
							}
						}
					}
				`,
				variables: { id: issueId },
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			console.error('Linear API error:', text);
			throw error(500, 'Failed to fetch Linear issue');
		}

		const data = await response.json();

		if (data.errors) {
			console.error('Linear GraphQL errors:', data.errors);
			throw error(500, 'Linear API returned errors');
		}

		const issue: LinearIssueWithComments | null = data.data?.issue || null;

		if (!issue) {
			throw error(404, 'Issue not found');
		}

		return json({ issue });
	} catch (err) {
		console.error('Error fetching Linear issue:', err);
		if (err instanceof Error && 'status' in err) {
			throw err;
		}
		throw error(500, 'Failed to fetch Linear issue');
	}
};
