export interface GitLabMergeRequest {
	iid: number;
	id: number;
	project_id: number;
	title: string;
	description: string;
	state: 'opened' | 'closed' | 'merged' | 'locked';
	web_url: string;
	sha: string;
	source_branch: string;
	target_branch: string;
	author: {
		username: string;
		name: string;
	};
	updated_at: string;
}

export interface GitLabMRNote {
	id: number;
	body: string;
	author: {
		username: string;
		name: string;
	};
	created_at: string;
	updated_at: string;
	system: boolean;
	noteable_type: string;
	position?: {
		base_sha: string;
		start_sha: string;
		head_sha: string;
		old_path: string;
		new_path: string;
		position_type: string;
		old_line: number | null;
		new_line: number | null;
		line_range?: {
			start: { line_code: string; type: string };
			end: { line_code: string; type: string };
		};
	};
	resolvable: boolean;
	resolved: boolean;
	resolved_by?: {
		username: string;
		name: string;
	};
}

export interface GitLabDiff {
	old_path: string;
	new_path: string;
	a_mode: string;
	b_mode: string;
	new_file: boolean;
	renamed_file: boolean;
	deleted_file: boolean;
	diff: string;
}

export interface MRReviewContext {
	mr: GitLabMergeRequest;
	notes: GitLabMRNote[];
	diffs: GitLabDiff[];
	unresolvedThreads: GitLabMRNote[];
}

export interface GitLabDiscussion {
	id: string;
	notes: GitLabMRNote[];
}

export interface GitLabUser {
	id: number;
	username: string;
	name: string;
	email?: string;
}
