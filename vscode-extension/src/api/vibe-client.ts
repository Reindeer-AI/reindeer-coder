import axios, { type AxiosInstance } from 'axios';

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
	 * Get the terminal snapshot for a task
	 * Note: Background polling keeps connections alive, so this should usually succeed immediately
	 */
	async getTerminalSnapshot(taskId: string): Promise<string> {
		try {
			console.log(`[VibeClient] Fetching terminal snapshot for task ${taskId}...`);
			const response = await this.client.get<{
				terminal_buffer: string;
				status?: string;
				retry_after?: number;
			}>(`/api/tasks/${taskId}/terminal/snapshot`, {
				validateStatus: (status) => status < 300 || status === 202,
				timeout: 60000, // 60 second timeout for terminal snapshots (allows for retries)
			});

			// Handle 202 Accepted (reconnecting) - wait and retry up to 3 times
			if (response.status === 202) {
				console.log(`[VibeClient] Terminal reconnecting for task ${taskId}, retrying...`);
				const retryAfter = response.data.retry_after || 3;
				const maxRetries = 3;

				for (let i = 0; i < maxRetries; i++) {
					await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
					console.log(`[VibeClient] Retry attempt ${i + 1}/${maxRetries}...`);

					const retryResponse = await this.client.get<{
						terminal_buffer: string;
						status?: string;
					}>(`/api/tasks/${taskId}/terminal/snapshot`, {
						validateStatus: (status) => status < 300 || status === 202,
						timeout: 60000, // 60 second timeout for retries
					});

					if (retryResponse.status === 200) {
						console.log(
							`[VibeClient] Received terminal buffer after retry: ${retryResponse.data.terminal_buffer.length} chars`
						);
						return retryResponse.data.terminal_buffer;
					}
				}

				// If still 202 after all retries, return empty or what we have
				console.log(`[VibeClient] Still reconnecting after ${maxRetries} retries, returning empty`);
				return response.data.terminal_buffer || '';
			}

			console.log(
				`[VibeClient] Received terminal buffer: ${response.data.terminal_buffer.length} chars`
			);
			return response.data.terminal_buffer;
		} catch (error) {
			console.error(`[VibeClient] Failed to get terminal snapshot for task ${taskId}:`, error);
			if ((error as any).response) {
				console.error(`[VibeClient] Response status: ${(error as any).response.status}`);
				console.error(`[VibeClient] Response data:`, (error as any).response.data);
			}
			throw new Error(`Failed to get terminal snapshot: ${error}`);
		}
	}

	/**
	 * Send text to a task's terminal
	 * Note: Background polling keeps connections alive, so this should usually succeed immediately
	 */
	async sendTextToTerminal(taskId: string, text: string): Promise<void> {
		try {
			console.log(`[VibeClient] Sending text to task ${taskId}...`);
			const response = await this.client.post<{ status?: string; retry_after?: number }>(
				`/api/tasks/${taskId}/send-text`,
				{ text },
				{
					validateStatus: (status) => status < 300 || status === 202,
					timeout: 60000, // 60 second timeout (allows for retries)
				}
			);

			// Handle 202 Accepted (reconnecting) - wait and retry up to 3 times
			if (response.status === 202) {
				console.log(`[VibeClient] Terminal reconnecting for task ${taskId}, retrying send...`);
				const retryAfter = response.data.retry_after || 3;
				const maxRetries = 3;

				for (let i = 0; i < maxRetries; i++) {
					await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
					console.log(`[VibeClient] Send retry attempt ${i + 1}/${maxRetries}...`);

					const retryResponse = await this.client.post<{ status?: string }>(
						`/api/tasks/${taskId}/send-text`,
						{ text },
						{
							validateStatus: (status) => status < 300 || status === 202,
							timeout: 60000, // 60 second timeout for retries
						}
					);

					if (retryResponse.status === 200) {
						console.log(`[VibeClient] Text sent successfully after retry`);
						return;
					}
				}

				// If still 202 after all retries, throw error
				throw new Error(
					`Terminal still reconnecting after ${maxRetries} retries. Please try again later.`
				);
			}

			console.log(`[VibeClient] Text sent successfully`);
		} catch (error) {
			console.error(`Failed to send text to task ${taskId}:`, error);
			throw new Error(`Failed to send text: ${error}`);
		}
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
}
