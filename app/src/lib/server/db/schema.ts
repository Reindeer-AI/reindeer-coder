export type TaskStatus =
	| 'pending'
	| 'provisioning'
	| 'initializing'
	| 'cloning'
	| 'running'
	| 'completed'
	| 'failed'
	| 'stopped'
	| 'deleted';

// Metadata stored as JSON - for integration-specific data (Linear, Jira, etc.)
export interface TaskMetadata {
	// VM configuration (captured at task creation for stability)
	vm_user?: string; // SSH user on the VM (e.g., 'agent', 'reindeer-vibe')
	workspace_path?: string; // Workspace path on the VM (e.g., '/home/agent/workspace')
	// Linear integration
	linear?: {
		issue_id: string;
		issue_identifier: string;
		issue_url: string;
		issue_title: string;
		connection_commands_posted?: boolean;
		attention_check_posted?: boolean;
	};
	// Jira integration (example)
	jira?: {
		issue_key: string;
		issue_url: string;
	};
	// Extensible for other integrations
	[key: string]: unknown;
}

export interface Task {
	id: string;
	user_id: string;
	user_email: string;
	repository: string;
	base_branch: string;
	feature_branch: string | null;
	task_description: string;
	coding_cli: 'claude-code' | 'gemini' | 'codex';
	system_prompt: string | null;
	status: TaskStatus;
	vm_name: string | null;
	vm_zone: string | null;
	vm_external_ip: string | null;
	terminal_buffer: string | null;
	terminal_file_path: string | null;
	// Git MR/PR info (works with GitLab, GitHub, etc.)
	mr_iid: number | null;
	mr_url: string | null;
	project_id: string | null;
	mr_last_review_sha: string | null;
	// JSON metadata for integrations
	metadata: TaskMetadata | null;
	created_at: string;
	updated_at: string;
}

export interface TaskLinearMetadata {
	issue_id: string;
	issue_identifier: string;
	issue_url: string;
	issue_title: string;
}

export interface TaskGitLabMetadata {
	mr_iid?: number;
	mr_url?: string;
	project_id?: string;
	last_review_sha?: string;
}

export interface TaskCreateInput {
	repository: string;
	base_branch: string;
	task_description: string;
	coding_cli: 'claude-code' | 'gemini' | 'codex';
	system_prompt?: string;
}

/**
 * Configuration key-value store for application settings
 */
export interface Config {
	key: string;
	value: string;
	description: string | null;
	is_secret: boolean;
	category: string | null;
	created_at: string;
	updated_at: string;
}

export interface ConfigCreateInput {
	key: string;
	value: string;
	description?: string;
	is_secret?: boolean;
	category?: string;
}

export interface ConfigUpdateInput {
	value?: string;
	description?: string;
	is_secret?: boolean;
	category?: string;
}
