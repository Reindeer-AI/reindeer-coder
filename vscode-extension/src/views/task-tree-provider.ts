import * as vscode from 'vscode';
import type { Task } from '../api/vibe-client';

export type TreeItemType = 'task' | 'details' | 'action';

export class TaskTreeItem extends vscode.TreeItem {
	constructor(
		public readonly task: Task,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
		public readonly itemType: TreeItemType = 'task',
		public readonly actionId?: string
	) {
		// Use first line of task_description as title, truncated to 50 chars
		// Handle null/undefined/empty descriptions gracefully
		let title = 'Untitled Task';
		try {
			if (task.task_description && typeof task.task_description === 'string') {
				const firstLine = task.task_description.split('\n')[0];
				title = firstLine.substring(0, 50) || `Task ${task.id.substring(0, 8)}`;
			} else {
				title = `Task ${task.id.substring(0, 8)}`;
			}
		} catch (error) {
			console.error('[TaskTreeItem] Error creating title:', error);
			title = `Task ${task.id.substring(0, 8)}`;
		}

		super(title, collapsibleState);

		this.id = `${itemType}-${task.id}${actionId ? `-${actionId}` : ''}`;
		this.contextValue = itemType;
		this.description = itemType === 'task' ? this.getStatusIcon(task.status) : undefined;
		this.tooltip = itemType === 'task' ? this.createTooltip() : undefined;

		// Set icon based on status for tasks
		if (itemType === 'task') {
			this.iconPath = new vscode.ThemeIcon(this.getThemeIcon(task.status));
		}
	}

	private getStatusIcon(status: string): string {
		switch (status) {
			case 'running':
				return '🟢 Running';
			case 'provisioning':
				return '⚙️ Provisioning';
			case 'initializing':
				return '🔄 Initializing';
			case 'cloning':
				return '📥 Cloning';
			case 'pending':
				return '🟡 Pending';
			case 'completed':
				return '✅ Completed';
			case 'failed':
				return '❌ Failed';
			case 'stopped':
				return '⏸️ Stopped';
			case 'deleted':
				return '🗑️ Deleted';
			default:
				return status;
		}
	}

	private getThemeIcon(status: string): string {
		switch (status) {
			case 'running':
				return 'debug-start';
			case 'provisioning':
			case 'initializing':
			case 'cloning':
				return 'sync~spin';
			case 'pending':
				return 'clock';
			case 'completed':
				return 'check';
			case 'failed':
				return 'error';
			case 'stopped':
				return 'debug-pause';
			case 'deleted':
				return 'trash';
			default:
				return 'circle-outline';
		}
	}

	private createTooltip(): vscode.MarkdownString {
		const tooltip = new vscode.MarkdownString();

		// Safely get task title
		let taskTitle = 'Untitled Task';
		try {
			if (this.task.task_description && typeof this.task.task_description === 'string') {
				taskTitle =
					this.task.task_description.split('\n')[0] || `Task ${this.task.id.substring(0, 8)}`;
			}
		} catch (_error) {
			taskTitle = `Task ${this.task.id.substring(0, 8)}`;
		}

		tooltip.appendMarkdown(`**${taskTitle}**\n\n`);
		tooltip.appendMarkdown(`**ID:** ${this.task.id}\n\n`);
		tooltip.appendMarkdown(`**Status:** ${this.task.status}\n\n`);

		if (this.task.repository) {
			tooltip.appendMarkdown(`**Repository:** ${this.task.repository}\n\n`);
		}

		if (this.task.base_branch) {
			tooltip.appendMarkdown(`**Branch:** ${this.task.base_branch}\n\n`);
		}

		if (this.task.feature_branch) {
			tooltip.appendMarkdown(`**Feature Branch:** ${this.task.feature_branch}\n\n`);
		}

		tooltip.appendMarkdown(`**CLI:** ${this.task.coding_cli}\n\n`);

		if (this.task.vm_name) {
			tooltip.appendMarkdown(`**VM:** ${this.task.vm_name} (${this.task.vm_zone})\n\n`);
		}

		if (this.task.mr_url) {
			tooltip.appendMarkdown(`**MR:** [${this.task.mr_iid}](${this.task.mr_url})\n\n`);
		}

		tooltip.appendMarkdown(`**Created:** ${new Date(this.task.created_at).toLocaleString()}\n\n`);
		tooltip.appendMarkdown(`**Updated:** ${new Date(this.task.updated_at).toLocaleString()}\n\n`);

		if (['provisioning', 'initializing', 'cloning', 'running'].includes(this.task.status)) {
			tooltip.appendMarkdown('_Click to connect to this task_');
		}

		return tooltip;
	}
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<
		TaskTreeItem | undefined | null | undefined
	>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private tasks: Task[] = [];
	private authenticated: boolean = false;
	private configured: boolean = true;

	/**
	 * Refresh the tree view
	 */
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	/**
	 * Set the list of tasks
	 */
	setTasks(tasks: Task[]): void {
		this.tasks = tasks;
		this.refresh();
	}

	/**
	 * Set authentication status
	 */
	setAuthenticated(authenticated: boolean): void {
		this.authenticated = authenticated;
		this.refresh();
	}

	/**
	 * Set configuration status
	 */
	setConfigured(configured: boolean): void {
		this.configured = configured;
		this.refresh();
	}

	/**
	 * Get tree item
	 */
	getTreeItem(element: TaskTreeItem): vscode.TreeItem {
		return element;
	}

	/**
	 * Get children (tasks or task details/actions)
	 */
	async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
		// If element is provided, show its children
		if (element) {
			// Only tasks have children
			if (element.itemType === 'task') {
				return this.getTaskChildren(element.task);
			}
			return [];
		}

		// Root level - check configuration first
		if (!this.configured) {
			return [this.createConfigurePrompt()];
		}

		// Then check authentication
		if (!this.authenticated) {
			return [this.createLoginPrompt()];
		}

		if (this.tasks.length === 0) {
			return [this.createEmptyState()];
		}

		return this.tasks.map(
			(task) => new TaskTreeItem(task, vscode.TreeItemCollapsibleState.Collapsed)
		);
	}

	/**
	 * Get children for a task (details and actions)
	 */
	private getTaskChildren(task: Task): TaskTreeItem[] {
		const children: TaskTreeItem[] = [];

		// Add details section
		const detailsItem = new TaskTreeItem(task, vscode.TreeItemCollapsibleState.Expanded, 'details');
		detailsItem.label = 'Details';
		detailsItem.iconPath = new vscode.ThemeIcon('info');
		detailsItem.description = '';
		detailsItem.tooltip = this.createDetailsTooltip(task);
		detailsItem.command = {
			command: 'reindeerCoder.showTaskDetails',
			title: 'Show Task Details',
			arguments: [task.id],
		};
		children.push(detailsItem);

		// Add Open in Web UI action
		const openWebUIAction = new TaskTreeItem(
			task,
			vscode.TreeItemCollapsibleState.None,
			'action',
			'open-web-ui'
		);
		openWebUIAction.label = 'Open in Web UI';
		openWebUIAction.iconPath = new vscode.ThemeIcon('globe');
		openWebUIAction.command = {
			command: 'reindeerCoder.openTaskWebUI',
			title: 'Open in Web UI',
			arguments: [task.id],
		};
		children.push(openWebUIAction);

		// Add Complete Task action
		const completeTaskAction = new TaskTreeItem(
			task,
			vscode.TreeItemCollapsibleState.None,
			'action',
			'complete-task'
		);
		completeTaskAction.label = 'Complete Task';
		completeTaskAction.iconPath = new vscode.ThemeIcon('check');
		completeTaskAction.command = {
			command: 'reindeerCoder.completeTask',
			title: 'Complete Task',
			arguments: [task.id],
		};
		children.push(completeTaskAction);

		// Add Delete Task action
		const deleteTaskAction = new TaskTreeItem(
			task,
			vscode.TreeItemCollapsibleState.None,
			'action',
			'delete-task'
		);
		deleteTaskAction.label = 'Delete Task';
		deleteTaskAction.iconPath = new vscode.ThemeIcon('trash');
		deleteTaskAction.command = {
			command: 'reindeerCoder.deleteTask',
			title: 'Delete Task',
			arguments: [task.id],
		};
		children.push(deleteTaskAction);

		return children;
	}

	/**
	 * Create detailed tooltip for task details
	 */
	private createDetailsTooltip(task: Task): vscode.MarkdownString {
		const tooltip = new vscode.MarkdownString();
		tooltip.appendMarkdown(`**Task Details**\n\n`);
		tooltip.appendMarkdown(`**ID:** ${task.id}\n\n`);
		tooltip.appendMarkdown(`**Status:** ${task.status}\n\n`);

		if (task.repository) {
			tooltip.appendMarkdown(`**Repository:** ${task.repository}\n\n`);
		}

		if (task.base_branch) {
			tooltip.appendMarkdown(`**Base Branch:** ${task.base_branch}\n\n`);
		}

		if (task.feature_branch) {
			tooltip.appendMarkdown(`**Feature Branch:** ${task.feature_branch}\n\n`);
		}

		if (task.vm_name) {
			tooltip.appendMarkdown(`**VM:** ${task.vm_name} (${task.vm_zone})\n\n`);
		}

		if (task.mr_url) {
			tooltip.appendMarkdown(`**Merge Request:** [!${task.mr_iid}](${task.mr_url})\n\n`);
		}

		tooltip.appendMarkdown(`**Created:** ${new Date(task.created_at).toLocaleString()}\n\n`);
		tooltip.appendMarkdown(`**Updated:** ${new Date(task.updated_at).toLocaleString()}`);

		return tooltip;
	}

	/**
	 * Create a configure server prompt tree item
	 */
	private createConfigurePrompt(): TaskTreeItem {
		const dummyTask: Task = {
			id: 'configure-prompt',
			user_id: '',
			user_email: '',
			repository: '',
			base_branch: '',
			feature_branch: null,
			task_description: 'Configure Server URL',
			coding_cli: 'claude-code',
			system_prompt: null,
			status: 'pending',
			vm_name: null,
			vm_zone: null,
			vm_external_ip: null,
			terminal_buffer: null,
			terminal_file_path: null,
			mr_iid: null,
			mr_url: null,
			project_id: null,
			mr_last_review_sha: null,
			metadata: null,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		const item = new TaskTreeItem(dummyTask, vscode.TreeItemCollapsibleState.None);
		item.contextValue = 'configure-prompt';
		item.command = {
			command: 'reindeerCoder.configureServer',
			title: 'Configure Server',
		};
		item.iconPath = new vscode.ThemeIcon('settings-gear');
		item.description = 'Click to set server URL';
		item.tooltip = new vscode.MarkdownString(
			'**Server URL Required**\n\nClick to configure the Reindeer Coder server URL.\n\nYou can also configure this in:\n- Settings → Extensions → Reindeer Coder\n- Command Palette → "Reindeer Coder: Configure Server"'
		);
		return item;
	}

	/**
	 * Create a login prompt tree item
	 */
	private createLoginPrompt(): TaskTreeItem {
		const dummyTask: Task = {
			id: 'login-prompt',
			user_id: '',
			user_email: '',
			repository: '',
			base_branch: '',
			feature_branch: null,
			task_description: 'Click to login',
			coding_cli: 'claude-code',
			system_prompt: null,
			status: 'pending',
			vm_name: null,
			vm_zone: null,
			vm_external_ip: null,
			terminal_buffer: null,
			terminal_file_path: null,
			mr_iid: null,
			mr_url: null,
			project_id: null,
			mr_last_review_sha: null,
			metadata: null,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		const item = new TaskTreeItem(dummyTask, vscode.TreeItemCollapsibleState.None);
		item.contextValue = 'login-prompt'; // Different context value to hide buttons
		item.command = {
			command: 'reindeerCoder.login',
			title: 'Login',
		};
		item.iconPath = new vscode.ThemeIcon('sign-in');
		item.description = '';
		return item;
	}

	/**
	 * Create an empty state tree item
	 */
	private createEmptyState(): TaskTreeItem {
		const dummyTask: Task = {
			id: 'empty-state',
			user_id: '',
			user_email: '',
			repository: '',
			base_branch: '',
			feature_branch: null,
			task_description: 'No active tasks',
			coding_cli: 'claude-code',
			system_prompt: null,
			status: 'pending',
			vm_name: null,
			vm_zone: null,
			vm_external_ip: null,
			terminal_buffer: null,
			terminal_file_path: null,
			mr_iid: null,
			mr_url: null,
			project_id: null,
			mr_last_review_sha: null,
			metadata: null,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};

		const item = new TaskTreeItem(dummyTask, vscode.TreeItemCollapsibleState.None);
		item.contextValue = 'empty-state'; // Different context value to hide buttons
		item.iconPath = new vscode.ThemeIcon('inbox');
		item.description = '';
		return item;
	}

	/**
	 * Get a specific task by ID
	 */
	getTask(taskId: string): Task | undefined {
		return this.tasks.find((task) => task.id === taskId);
	}
}
