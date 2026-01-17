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
	metadata: any | null;
	created_at: string;
	updated_at: string;
	needsAttention?: boolean;
	terminalPreview?: string;
}

export class VibeClient {
	private client: AxiosInstance;

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
			return config;
		});
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
}
