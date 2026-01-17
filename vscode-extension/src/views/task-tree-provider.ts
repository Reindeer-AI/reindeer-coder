import * as vscode from 'vscode';
import { Task } from '../api/vibe-client';

export class TaskTreeItem extends vscode.TreeItem {
  constructor(
    public readonly task: Task,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
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

    this.id = task.id;
    this.contextValue = 'task';
    this.description = this.getStatusIcon(task.status);
    this.tooltip = this.createTooltip();

    // Set icon based on status
    this.iconPath = new vscode.ThemeIcon(this.getThemeIcon(task.status));
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
        taskTitle = this.task.task_description.split('\n')[0] || `Task ${this.task.id.substring(0, 8)}`;
      }
    } catch (error) {
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
  private _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tasks: Task[] = [];
  private authenticated: boolean = false;

  constructor() {}

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
   * Get tree item
   */
  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children (tasks)
   */
  async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
    if (element) {
      return [];
    }

    if (!this.authenticated) {
      return [this.createLoginPrompt()];
    }

    if (this.tasks.length === 0) {
      return [this.createEmptyState()];
    }

    return this.tasks.map(
      task => new TaskTreeItem(task, vscode.TreeItemCollapsibleState.None)
    );
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
      command: 'vibeCoding.login',
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
    return this.tasks.find(task => task.id === taskId);
  }
}
