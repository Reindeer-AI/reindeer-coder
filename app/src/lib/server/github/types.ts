export interface GitHubPullRequest {
	number: number;
	id: number;
	title: string;
	body: string | null;
	state: 'open' | 'closed';
	merged: boolean;
	html_url: string;
	head: {
		sha: string;
		ref: string;
	};
	base: {
		ref: string;
	};
	user: {
		login: string;
		id: number;
	} | null;
	updated_at: string;
}

export interface GitHubReviewComment {
	id: number;
	body: string;
	user: {
		login: string;
		id: number;
	} | null;
	created_at: string;
	updated_at: string;
	path: string;
	position: number | null;
	original_position: number | null;
	line: number | null;
	original_line: number | null;
	start_line: number | null;
	original_start_line: number | null;
	side: 'LEFT' | 'RIGHT';
	start_side: 'LEFT' | 'RIGHT' | null;
	in_reply_to_id?: number;
	pull_request_review_id: number | null;
}

export interface GitHubIssueComment {
	id: number;
	body: string;
	user: {
		login: string;
		id: number;
	} | null;
	created_at: string;
	updated_at: string;
}

export interface GitHubFile {
	sha: string;
	filename: string;
	status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
	additions: number;
	deletions: number;
	changes: number;
	patch?: string;
	previous_filename?: string;
}

export interface PRReviewContext {
	pr: GitHubPullRequest;
	reviewComments: GitHubReviewComment[];
	issueComments: GitHubIssueComment[];
	files: GitHubFile[];
	pendingReviewComments: GitHubReviewComment[];
}

export interface GitHubUser {
	id: number;
	login: string;
	name: string | null;
	email: string | null;
}

export interface GitHubReview {
	id: number;
	user: {
		login: string;
		id: number;
	} | null;
	body: string | null;
	state: 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED';
	submitted_at: string | null;
}
