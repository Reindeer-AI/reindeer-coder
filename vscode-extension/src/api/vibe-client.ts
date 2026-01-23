import axios, { type AxiosInstance } from 'axios';

/**
 * Extension configuration returned by the server
 */
export interface ExtensionConfig {
	auth0: {
		domain: string;
		clientId: string;
		audience: string;
		organizationId?: string;
	};
	gcp: {
		project: string;
	};
	vm: {
		user: string;
	};
	app: {
		url: string;
	};
	agent: {
		defaultSystemPrompt: string;
	};
}

/**
 * Fetch extension configuration from server (no auth required)
 * This is used to bootstrap the extension before authentication
 */
export async function fetchExtensionConfig(serverUrl: string): Promise<ExtensionConfig> {
	const response = await axios.get<ExtensionConfig>(`${serverUrl}/api/extension-config`, {
		timeout: 10000,
	});
	return response.data;
}

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
	};
	// Extensible
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
	mr_iid: number | null;
	mr_url: string | null;
	project_id: string | null;
	mr_last_review_sha: string | null;
	metadata: TaskMetadata | null;
	created_at: string;
	updated_at: string;
	needsAttention?: boolean;
	terminalPreview?: string;
}

export class VibeClient {
	private client: AxiosInstance;
	private onAuthError?: () => void;

	constructor(
		readonly apiUrl: string,
		private readonly getAccessToken: () => Promise<string | null>
	) {
		this.client = axios.create({
			baseURL: apiUrl,
			timeout: 30000,
		});

		// Add auth interceptor
		this.client.interceptors.request.use(async (config) => {
			const token = await this.getAccessToken();
			if (token) {
				config.headers.Authorization = `Bearer ${token}`;
			}
			console.log(`[VibeClient] → ${config.method?.toUpperCase()} ${config.url}`);
			if (config.data) {
				console.log(`[VibeClient] → Request body:`, config.data);
			}
			return config;
		});

		// Add response interceptor to handle 401 errors
		this.client.interceptors.response.use(
			(response) => {
				console.log(
					`[VibeClient] ← ${response.status} ${response.config.method?.toUpperCase()} ${response.config.url}`
				);
				if (response.data) {
					console.log(`[VibeClient] ← Response data:`, response.data);
				}
				return response;
			},
			async (error) => {
				if (error.response) {
					console.log(
						`[VibeClient] ← ${error.response.status} ${error.config?.method?.toUpperCase()} ${error.config?.url}`
					);
					console.log(`[VibeClient] ← Error response:`, error.response.data);

					if (error.response.status === 401) {
						console.log('[VibeClient] 401 Unauthorized - triggering authentication flow');
						if (this.onAuthError) {
							this.onAuthError();
						}
					}
				} else {
					console.log(`[VibeClient] ← Network error:`, error.message);
				}
				return Promise.reject(error);
			}
		);
	}

	/**
	 * Set callback for authentication errors (401)
	 */
	setAuthErrorHandler(handler: () => void): void {
		this.onAuthError = handler;
	}

	/**
	 * List all tasks for the authenticated user
	 */
	async listTasks(): Promise<Task[]> {
		try {
			console.log('[VibeClient] Fetching tasks from /api/tasks...');
			const response = await this.client.get<{ tasks: Task[] }>('/api/tasks');
			console.log('[VibeClient] Response status:', response.status);
			console.log('[VibeClient] Response data keys:', Object.keys(response.data));
			console.log('[VibeClient] Tasks count:', response.data.tasks?.length || 0);

			if (response.data.tasks && response.data.tasks.length > 0) {
				console.log(
					'[VibeClient] First task sample:',
					JSON.stringify(response.data.tasks[0], null, 2)
				);
			}

			return response.data.tasks || [];
		} catch (error) {
			console.error('[VibeClient] Failed to list tasks:', error);
			if (error && typeof error === 'object' && 'response' in error) {
				const axiosError = error as any;
				console.error('[VibeClient] Response status:', axiosError.response?.status);
				console.error('[VibeClient] Response data:', axiosError.response?.data);
			}
			throw new Error(`Failed to list tasks: ${error}`);
		}
	}

	/**
	 * Get detailed information about a specific task
	 */
	async getTask(taskId: string): Promise<Task> {
		try {
			const response = await this.client.get<{ task: Task }>(`/api/tasks/${taskId}`);
			return response.data.task;
		} catch (error) {
			console.error(`Failed to get task ${taskId}:`, error);
			throw new Error(`Failed to get task: ${error}`);
		}
	}

	/**
	 * List active (running) tasks
	 */
	async listActiveTasks(): Promise<Task[]> {
		const tasks = await this.listTasks();
		return tasks.filter((task) =>
			['provisioning', 'initializing', 'cloning', 'running'].includes(task.status)
		);
	}

	/**
	 * Fetch available repositories from config
	 */
	async getRepositories(): Promise<
		Array<{ id: string; name: string; url: string; baseBranch: string; allowManual: boolean }>
	> {
		try {
			console.log('[VibeClient] Fetching repositories from config...');
			const response = await this.client.get<{ config: { value: string } }>(
				'/api/config/repositories.list'
			);

			if (!response.data.config?.value) {
				return [];
			}

			const repos = JSON.parse(response.data.config.value);
			console.log(`[VibeClient] Fetched ${repos.length} repositories`);
			return repos;
		} catch (error) {
			console.error('[VibeClient] Failed to fetch repositories:', error);
			return [];
		}
	}

	/**
	 * Create a new task
	 */
	async createTask(taskData: {
		repository: string;
		base_branch: string;
		task_description: string;
		coding_cli: 'claude-code' | 'gemini' | 'codex';
		system_prompt?: string;
		user_email?: string;
	}): Promise<Task> {
		try {
			console.log('[VibeClient] Creating new task...');
			const response = await this.client.post<{ task: Task }>('/api/tasks', taskData);
			console.log(`[VibeClient] Task created: ${response.data.task.id}`);
			return response.data.task;
		} catch (error) {
			console.error('[VibeClient] Failed to create task:', error);
			throw new Error(`Failed to create task: ${error}`);
		}
	}

	/**
	 * Complete a task (marks as completed and stops VM)
	 */
	async completeTask(taskId: string): Promise<Task> {
		try {
			console.log(`[VibeClient] Completing task ${taskId}...`);
			const response = await this.client.put<{ task: Task }>(`/api/tasks/${taskId}`, {
				status: 'completed',
			});
			console.log(`[VibeClient] Task completed: ${taskId}`);
			return response.data.task;
		} catch (error) {
			console.error(`[VibeClient] Failed to complete task ${taskId}:`, error);
			throw new Error(`Failed to complete task: ${error}`);
		}
	}

	/**
	 * Delete a task (marks as deleted and stops VM)
	 */
	async deleteTask(taskId: string): Promise<void> {
		try {
			console.log(`[VibeClient] Deleting task ${taskId}...`);
			await this.client.delete(`/api/tasks/${taskId}`);
			console.log(`[VibeClient] Task deleted: ${taskId}`);
		} catch (error) {
			console.error(`[VibeClient] Failed to delete task ${taskId}:`, error);
			throw new Error(`Failed to delete task: ${error}`);
		}
	}

	/**
	 * Get the default system prompt from server config
	 */
	async getDefaultSystemPrompt(): Promise<string> {
		try {
			console.log('[VibeClient] Fetching default system prompt from config...');
			const response = await this.client.get<{ config: { value: string } }>(
				'/api/config/agent.default_system_prompt'
			);
			return response.data.config?.value || '';
		} catch (error) {
			console.error('[VibeClient] Failed to fetch default system prompt:', error);
			return '';
		}
	}
}
