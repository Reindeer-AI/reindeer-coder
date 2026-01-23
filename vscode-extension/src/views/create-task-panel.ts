import * as vscode from 'vscode';
import type { ExtensionConfig, VibeClient } from '../api/vibe-client';
import type { Auth0Client } from '../auth/auth0-client';

export class CreateTaskPanel {
	public static currentPanel: CreateTaskPanel | undefined;
	private readonly _panel: vscode.WebviewPanel;
	private _disposables: vscode.Disposable[] = [];

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly auth0Client: Auth0Client,
		private readonly vibeClient: VibeClient,
		private readonly extensionConfig: ExtensionConfig,
		private readonly onTaskCreated: () => void
	) {
		this._panel = panel;

		// Set the webview's initial html content
		this._update();

		// Listen for when the panel is disposed
		// This happens when the user closes the panel or when the panel is closed programmatically
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

		// Handle messages from the webview
		this._panel.webview.onDidReceiveMessage(
			async (message) => {
				switch (message.command) {
					case 'createTask':
						await this._handleCreateTask(message.data);
						return;
					case 'fetchRepositories':
						await this._handleFetchRepositories();
						return;
					case 'getDefaultSystemPrompt':
						await this._handleGetDefaultSystemPrompt();
						return;
				}
			},
			null,
			this._disposables
		);
	}

	public static createOrShow(
		_extensionUri: vscode.Uri,
		auth0Client: Auth0Client,
		vibeClient: VibeClient,
		extensionConfig: ExtensionConfig,
		onTaskCreated: () => void
	) {
		const column = vscode.ViewColumn.One;

		// If we already have a panel, show it.
		if (CreateTaskPanel.currentPanel) {
			CreateTaskPanel.currentPanel._panel.reveal(column);
			return;
		}

		// Otherwise, create a new panel.
		const panel = vscode.window.createWebviewPanel(
			'reindeerCoderCreateTask',
			'Create New Task',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		CreateTaskPanel.currentPanel = new CreateTaskPanel(
			panel,
			auth0Client,
			vibeClient,
			extensionConfig,
			onTaskCreated
		);
	}

	private async _handleFetchRepositories() {
		try {
			const repositories = await this.vibeClient.getRepositories();
			this._panel.webview.postMessage({
				command: 'repositoriesFetched',
				data: repositories,
			});
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to fetch repositories: ${error}`);
		}
	}

	private async _handleGetDefaultSystemPrompt() {
		try {
			const userInfo = await this.auth0Client.getUserInfo();
			const userEmail = userInfo?.email || 'unknown';
			const userName = userInfo?.name || 'User';

			// Get default system prompt from server config and personalize it
			let defaultSystemPrompt = this.extensionConfig.agent.defaultSystemPrompt;

			// Add user-specific git configuration instructions
			const gitConfigInstructions = `
Use ${userEmail} as your identity for git commits and merge requests. Use the name "Claude Code on behalf of ${userName}". Configure git before making any commits:
   git config user.email "${userEmail}"
   git config user.name "Claude Code on behalf of ${userName}"

`;
			defaultSystemPrompt = gitConfigInstructions + defaultSystemPrompt;

			this._panel.webview.postMessage({
				command: 'defaultSystemPromptFetched',
				data: defaultSystemPrompt,
			});
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to get default system prompt: ${error}`);
		}
	}

	private async _handleCreateTask(data: {
		repository: string;
		baseBranch: string;
		taskDescription: string;
		codingCli: 'claude-code' | 'gemini' | 'codex';
		systemPrompt: string;
	}) {
		try {
			await this.vibeClient.createTask({
				repository: data.repository,
				base_branch: data.baseBranch,
				task_description: data.taskDescription,
				coding_cli: data.codingCli,
				system_prompt: data.systemPrompt || undefined,
			});

			vscode.window.showInformationMessage('Task created successfully!');
			this.onTaskCreated();
			this._panel.dispose();
		} catch (error) {
			this._panel.webview.postMessage({
				command: 'createTaskError',
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	}

	public dispose() {
		CreateTaskPanel.currentPanel = undefined;

		// Clean up our resources
		this._panel.dispose();

		while (this._disposables.length) {
			const x = this._disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	private _update() {
		const webview = this._panel.webview;
		this._panel.webview.html = this._getHtmlForWebview(webview);
	}

	private _getHtmlForWebview(_webview: vscode.Webview) {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Create New Task</title>
	<style>
		body {
			padding: 20px;
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			font-family: var(--vscode-font-family);
		}
		.form-group {
			margin-bottom: 20px;
		}
		label {
			display: block;
			margin-bottom: 5px;
			font-weight: 600;
		}
		input[type="text"], textarea, select {
			width: 100%;
			padding: 8px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 2px;
			box-sizing: border-box;
		}
		textarea {
			min-height: 150px;
			resize: vertical;
			font-family: var(--vscode-editor-font-family);
		}
		.button-group {
			display: flex;
			gap: 10px;
			margin-top: 20px;
		}
		button {
			padding: 8px 16px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 2px;
			cursor: pointer;
			font-size: 14px;
		}
		button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		button:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		.secondary-button {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.secondary-button:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}
		.error {
			color: var(--vscode-errorForeground);
			background: var(--vscode-inputValidation-errorBackground);
			border: 1px solid var(--vscode-inputValidation-errorBorder);
			padding: 10px;
			margin-bottom: 15px;
			border-radius: 2px;
		}
		.radio-group {
			display: flex;
			gap: 20px;
			margin-top: 8px;
		}
		.radio-group label {
			display: flex;
			align-items: center;
			gap: 8px;
			font-weight: normal;
		}
		.description {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			margin-top: 4px;
		}
	</style>
</head>
<body>
	<h1>Create New Task</h1>

	<div id="error" class="error" style="display: none;"></div>

	<form id="taskForm">
		<div class="form-group">
			<label for="repository">Repository</label>
			<select id="repositorySelect">
				<option value="custom">Custom Repository</option>
			</select>
		</div>

		<div class="form-group">
			<label for="repositoryUrl">Repository URL</label>
			<input type="text" id="repositoryUrl" placeholder="https://github.com/user/repo.git" required />
		</div>

		<div class="form-group">
			<label for="baseBranch">Base Branch</label>
			<input type="text" id="baseBranch" value="main" required />
		</div>

		<div class="form-group">
			<label for="taskDescription">Task Description</label>
			<textarea id="taskDescription" placeholder="Describe what you want the agent to do..." required></textarea>
		</div>

		<div class="form-group">
			<label>AI Agent</label>
			<div class="radio-group">
				<label>
					<input type="radio" name="codingCli" value="claude-code" checked />
					Claude Code
				</label>
				<label>
					<input type="radio" name="codingCli" value="gemini" />
					Gemini
				</label>
				<label>
					<input type="radio" name="codingCli" value="codex" />
					Codex
				</label>
			</div>
		</div>

		<div class="form-group">
			<label for="systemPrompt">System Prompt (Optional)</label>
			<textarea id="systemPrompt" placeholder="Custom instructions for the agent..."></textarea>
			<div class="description">Leave empty to use default system prompt</div>
		</div>

		<div class="button-group">
			<button type="submit" id="createButton">Create Task</button>
			<button type="button" class="secondary-button" id="cancelButton">Cancel</button>
		</div>
	</form>

	<script>
		const vscode = acquireVsCodeApi();

		// Fetch repositories and default system prompt on load
		vscode.postMessage({ command: 'fetchRepositories' });
		vscode.postMessage({ command: 'getDefaultSystemPrompt' });

		const repositorySelect = document.getElementById('repositorySelect');
		const repositoryUrl = document.getElementById('repositoryUrl');
		const baseBranch = document.getElementById('baseBranch');
		const systemPromptTextarea = document.getElementById('systemPrompt');
		const errorDiv = document.getElementById('error');

		// Handle repository selection
		repositorySelect.addEventListener('change', () => {
			const selectedValue = repositorySelect.value;
			if (selectedValue === 'custom') {
				repositoryUrl.value = '';
				repositoryUrl.readOnly = false;
				baseBranch.value = 'main';
				baseBranch.readOnly = false;
			} else {
				const selectedOption = repositorySelect.options[repositorySelect.selectedIndex];
				repositoryUrl.value = selectedOption.dataset.url || '';
				repositoryUrl.readOnly = true;
				baseBranch.value = selectedOption.dataset.baseBranch || 'main';
				baseBranch.readOnly = true;
			}
		});

		// Handle messages from the extension
		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.command) {
				case 'repositoriesFetched':
					const repos = message.data || [];
					repos.forEach(repo => {
						const option = document.createElement('option');
						option.value = repo.id;
						option.textContent = repo.name;
						option.dataset.url = repo.url;
						option.dataset.baseBranch = repo.baseBranch;
						repositorySelect.appendChild(option);
					});
					break;
				case 'defaultSystemPromptFetched':
					systemPromptTextarea.value = message.data;
					break;
				case 'createTaskError':
					errorDiv.textContent = message.error;
					errorDiv.style.display = 'block';
					document.getElementById('createButton').disabled = false;
					break;
			}
		});

		// Handle form submission
		document.getElementById('taskForm').addEventListener('submit', (e) => {
			e.preventDefault();
			errorDiv.style.display = 'none';

			const repository = repositoryUrl.value.trim();
			const baseBranchValue = baseBranch.value.trim();
			const taskDescription = document.getElementById('taskDescription').value.trim();
			const codingCli = document.querySelector('input[name="codingCli"]:checked').value;
			const systemPrompt = document.getElementById('systemPrompt').value.trim();

			if (!repository || !baseBranchValue || !taskDescription) {
				errorDiv.textContent = 'Please fill in all required fields';
				errorDiv.style.display = 'block';
				return;
			}

			document.getElementById('createButton').disabled = true;

			vscode.postMessage({
				command: 'createTask',
				data: {
					repository,
					baseBranch: baseBranchValue,
					taskDescription,
					codingCli,
					systemPrompt
				}
			});
		});

		// Handle cancel button
		document.getElementById('cancelButton').addEventListener('click', () => {
			vscode.postMessage({ command: 'cancel' });
		});
	</script>
</body>
</html>`;
	}
}
