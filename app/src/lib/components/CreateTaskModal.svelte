<script lang="ts">
import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { authToken, user } from '$lib/stores/auth';

interface Props {
	onclose: () => void;
}

let { onclose }: Props = $props();

interface LinearIssue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	state: {
		name: string;
		color: string;
	};
	priority: number;
	estimate: number | null;
	labels: {
		nodes: Array<{
			name: string;
			color: string;
		}>;
	};
	assignee: {
		name: string;
		email: string;
	} | null;
	project: {
		name: string;
	} | null;
	url: string;
}

interface LinearComment {
	id: string;
	body: string;
	createdAt: string;
	user: {
		name: string;
		email: string;
	} | null;
}

interface LinearIssueWithComments extends LinearIssue {
	comments?: {
		nodes: LinearComment[];
	};
}

interface PreConfiguredRepo {
	id: string;
	name: string;
	url: string;
	baseBranch: string;
	allowManual: boolean;
}

let preConfiguredRepos: PreConfiguredRepo[] = $state([]);

let selectedRepoId = $state<string>('custom');
let showRepoDropdown = $state(false);
let repository = $state('');
let baseBranch = $state('main');
let taskDescription = $state('');
let codingCli = $state<'claude-code' | 'gemini' | 'codex'>('claude-code');
let submitting = $state(false);
let error = $state<string | null>(null);

// Linear integration
let taskSource = $state<'manual' | 'linear'>('linear');
let linearIssues = $state<LinearIssue[]>([]);
let linearSearch = $state('');
let selectedLinearIssue = $state<LinearIssue | null>(null);
let loadingLinear = $state(false);
let linearError = $state<string | null>(null);
let showLinearDropdown = $state(false);

// Default system prompt fetched from server config
let defaultSystemPromptFromServer = $state('');

// Dynamic system prompt based on logged-in user
function getBaseSystemPrompt(): string {
	const userEmail = $user?.email;
	const userName = $user?.name;

	// Start with git config instructions
	const gitConfig = `Use ${userEmail} as your identity for git commits and merge requests. Use the name "Claude Code on behalf of ${userName}". Configure git before making any commits:
   git config user.email "${userEmail}"
   git config user.name "Claude Code on behalf of ${userName}"

`;

	// Use server-provided system prompt if available, otherwise use a basic default
	const basePrompt =
		defaultSystemPromptFromServer ||
		`You are a software engineer. Follow these guidelines:

1. Write clean, well-documented code following the project's existing patterns and conventions
2. When making code changes, create a new feature branch from the base branch
3. After completing the task, create a detailed merge request
4. Commit messages should be descriptive and follow conventional commit format
5. Work autonomously - make reasonable decisions without asking for confirmation
6. If you encounter minor blockers, try alternative approaches before escalating`;

	return gitConfig + basePrompt;
}

const linearSystemPromptAddition = `
IMPORTANT: This task is linked to a Linear ticket. When creating the merge request:
- Add "ref {TICKET_ID}" at the BEGINNING of the MR description (e.g., "ref REI-123")
- This will automatically link the MR to the Linear ticket`;

let systemPrompt = $state(getBaseSystemPrompt());

// localStorage persistence
interface FormState {
	selectedRepoId: string;
	repository: string;
	baseBranch: string;
	taskSource: 'manual' | 'linear';
	linearSearch: string;
	selectedLinearIssue: LinearIssue | null;
	codingCli: 'claude-code' | 'gemini' | 'codex';
	systemPrompt: string;
}

function saveFormState() {
	try {
		const state: FormState = {
			selectedRepoId,
			repository,
			baseBranch,
			taskSource,
			linearSearch,
			selectedLinearIssue,
			codingCli,
			systemPrompt,
		};
		localStorage.setItem('vibe-coding-task-form-state', JSON.stringify(state));
	} catch (err) {
		console.error('Failed to save form state:', err);
	}
}

function loadFormState() {
	try {
		const saved = localStorage.getItem('vibe-coding-task-form-state');
		if (saved) {
			const state: FormState = JSON.parse(saved);
			selectedRepoId = state.selectedRepoId;
			repository = state.repository;
			baseBranch = state.baseBranch;
			taskSource = state.taskSource;
			linearSearch = state.linearSearch;
			selectedLinearIssue = state.selectedLinearIssue;
			codingCli = state.codingCli;
			systemPrompt = state.systemPrompt;
		}
	} catch (err) {
		console.error('Failed to load form state:', err);
	}
}

const cliOptions = [
	{
		value: 'claude-code',
		label: 'Claude Code',
		icon: '🤖',
		description: 'Anthropic Claude for coding',
		comingSoon: false,
	},
	{
		value: 'gemini',
		label: 'Gemini',
		icon: '✨',
		description: 'Google Gemini CLI',
		comingSoon: false,
	},
	{ value: 'codex', label: 'Codex', icon: '💻', description: 'OpenAI Codex', comingSoon: false },
];

const priorityLabels: Record<number, string> = {
	0: 'No priority',
	1: 'Urgent',
	2: 'High',
	3: 'Medium',
	4: 'Low',
};

// Fetch Linear issues on mount and load saved form state
onMount(async () => {
	loadFormState();
	// Clear task description but keep other fields
	taskDescription = '';
	await fetchLinearIssues();
	await fetchRepositories();
	await fetchDefaultSystemPrompt();
});

async function fetchRepositories() {
	try {
		const token = $authToken;
		if (!token) return;

		const res = await fetch('/api/config/repositories.list', {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (res.ok) {
			const data = await res.json();
			try {
				preConfiguredRepos = JSON.parse(data.config.value);
			} catch {
				preConfiguredRepos = [];
			}
		}
	} catch (err) {
		console.error('Failed to load repositories:', err);
	}
}

async function fetchDefaultSystemPrompt() {
	try {
		const token = $authToken;
		if (!token) return;

		const res = await fetch('/api/config/agent.default_system_prompt', {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (res.ok) {
			const data = await res.json();
			if (data.config?.value) {
				defaultSystemPromptFromServer = data.config.value;
				// Update the system prompt if user hasn't customized it
				systemPrompt = getBaseSystemPrompt();
			}
		}
	} catch (err) {
		console.error('Failed to load default system prompt:', err);
	}
}

// Save form state on changes (using $effect for Svelte 5)
$effect(() => {
	// Watch these values and save when they change
	selectedRepoId;
	repository;
	baseBranch;
	taskSource;
	linearSearch;
	selectedLinearIssue;
	codingCli;
	systemPrompt;
	saveFormState();
});

async function fetchLinearIssues() {
	loadingLinear = true;
	linearError = null;

	try {
		const response = await fetch('/api/linear/issues', {
			headers: { Authorization: `Bearer ${$authToken}` },
		});

		if (!response.ok) {
			if (response.status === 500) {
				const data = await response.json().catch(() => ({}));
				if (data.message?.includes('not configured')) {
					linearError = 'Linear API key not configured';
					return;
				}
			}
			throw new Error('Failed to fetch Linear issues');
		}

		const data = await response.json();
		linearIssues = data.issues;
	} catch (err) {
		linearError = err instanceof Error ? err.message : 'Failed to load Linear issues';
	} finally {
		loadingLinear = false;
	}
}

// Filter issues based on search
function getFilteredIssues(): LinearIssue[] {
	if (!linearSearch.trim()) {
		return linearIssues.slice(0, 20); // Show first 20 when no search
	}
	const search = linearSearch.toLowerCase();
	return linearIssues
		.filter(
			(issue) =>
				issue.identifier.toLowerCase().includes(search) ||
				issue.title.toLowerCase().includes(search)
		)
		.slice(0, 20);
}

async function selectLinearIssue(issue: LinearIssue) {
	selectedLinearIssue = issue;
	linearSearch = `${issue.identifier}: ${issue.title}`;
	showLinearDropdown = false;

	// Fetch full issue data including comments
	loadingLinear = true;
	try {
		const response = await fetch(`/api/linear/issues/${issue.id}`, {
			headers: { Authorization: `Bearer ${$authToken}` },
		});

		if (!response.ok) {
			throw new Error('Failed to fetch issue details');
		}

		const data = await response.json();
		const issueWithComments = data.issue as LinearIssueWithComments;

		// Build comprehensive task description with description + all comments
		const parts = [
			`# ${issue.identifier}: ${issue.title}`,
			``,
			`Linear Ticket: ${issue.url}`,
			`Status: ${issue.state.name}`,
			`Priority: ${priorityLabels[issue.priority] || 'Unknown'}`,
		];

		if (issue.project) {
			parts.push(`Project: ${issue.project.name}`);
		}

		if (issue.labels.nodes.length > 0) {
			parts.push(`Labels: ${issue.labels.nodes.map((l) => l.name).join(', ')}`);
		}

		if (issue.estimate) {
			parts.push(`Estimate: ${issue.estimate} points`);
		}

		parts.push('', '---', '');

		// Add description
		if (issue.description) {
			parts.push('## Description', '', issue.description, '');
		}

		// Add all comments
		if (issueWithComments.comments && issueWithComments.comments.nodes.length > 0) {
			parts.push('## Comments', '');

			issueWithComments.comments.nodes.forEach((comment, idx) => {
				const author = comment.user ? comment.user.name : 'Unknown';
				const date = new Date(comment.createdAt).toLocaleString();
				parts.push(`### Comment ${idx + 1} by ${author} (${date})`, '', comment.body, '');
			});
		}

		taskDescription = parts.join('\n');

		// Update system prompt with Linear-specific instruction
		systemPrompt =
			getBaseSystemPrompt() + linearSystemPromptAddition.replace('{TICKET_ID}', issue.identifier);
	} catch (err) {
		console.error('Error fetching Linear issue details:', err);
		linearError = 'Failed to load issue details. Please try again.';
	} finally {
		loadingLinear = false;
	}
}

function clearLinearSelection() {
	selectedLinearIssue = null;
	linearSearch = '';
	taskDescription = '';
	systemPrompt = getBaseSystemPrompt();
}

function getSelectedRepoDisplay(): string {
	if (selectedRepoId === 'custom') {
		return 'Custom Repository';
	}
	const repo = preConfiguredRepos.find((r) => r.id === selectedRepoId);
	return repo ? `${repo.name} (${repo.baseBranch})` : 'Select Repository';
}

function handleRepoSelection(repoId: string) {
	selectedRepoId = repoId;
	showRepoDropdown = false;

	if (repoId === 'custom') {
		// Reset to defaults for custom
		repository = '';
		baseBranch = 'main';
	} else {
		// Find and apply pre-configured repo settings
		const repo = preConfiguredRepos.find((r) => r.id === repoId);
		if (repo) {
			repository = repo.url;
			baseBranch = repo.baseBranch;
		}
	}
}

function handleSourceChange(source: 'manual' | 'linear') {
	taskSource = source;
	if (source === 'manual') {
		clearLinearSelection();
	}
}

function isManualAllowed(): boolean {
	if (selectedRepoId === 'custom') return true;
	const selectedRepo = preConfiguredRepos.find((r) => r.id === selectedRepoId);
	return selectedRepo?.allowManual ?? true;
}

async function handleSubmit() {
	if (!repository || !taskDescription) {
		error = 'Please fill in all required fields';
		return;
	}

	submitting = true;
	error = null;

	try {
		const requestBody: {
			repository: string;
			base_branch: string;
			task_description: string;
			coding_cli: string;
			system_prompt?: string;
			user_email?: string;
			linear_metadata?: {
				issue_id: string;
				issue_identifier: string;
				issue_url: string;
				issue_title: string;
			};
		} = {
			repository,
			base_branch: baseBranch,
			task_description: taskDescription,
			coding_cli: codingCli,
			system_prompt: systemPrompt || undefined,
			user_email: $user?.email,
		};

		// Include Linear metadata if task was created from Linear
		if (taskSource === 'linear' && selectedLinearIssue) {
			requestBody.linear_metadata = {
				issue_id: selectedLinearIssue.id,
				issue_identifier: selectedLinearIssue.identifier,
				issue_url: selectedLinearIssue.url,
				issue_title: selectedLinearIssue.title,
			};
		}

		const response = await fetch('/api/tasks', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${$authToken}`,
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.message || 'Failed to create task');
		}

		const data = await response.json();
		onclose();
		goto(`/tasks/${data.task.id}`);
	} catch (err) {
		error = err instanceof Error ? err.message : 'Unknown error';
	} finally {
		submitting = false;
	}
}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onclick={onclose}>
	<div
		class="bg-white border border-gray-200 rounded-2xl w-[90vw] max-w-7xl max-h-[90vh] overflow-y-auto shadow-2xl"
		onclick={(e) => e.stopPropagation()}
	>
		<div class="p-8 border-b border-gray-200 bg-gray-50">
			<h2 class="text-2xl font-semibold text-gray-900">Create New Task</h2>
			<p class="text-gray-500 text-sm mt-1">Configure your AI coding agent</p>
		</div>

		<form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="p-8">
			{#if error}
				<div class="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm mb-6">
					{error}
				</div>
			{/if}

			<div class="grid grid-cols-2 gap-8">
				<!-- Left Column -->
				<div class="space-y-5">

			<!-- Repository Selection -->
			<div class="relative">
				<label class="block text-sm font-medium text-gray-700 mb-2">
					Select Repository
				</label>
				<button
					type="button"
					onclick={() => showRepoDropdown = !showRepoDropdown}
					class="w-full px-4 py-3 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green text-left flex items-center justify-between"
				>
					<span>{getSelectedRepoDisplay()}</span>
					<svg
						class="w-5 h-5 text-gray-400 transition-transform {showRepoDropdown ? 'rotate-180' : ''}"
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 20 20"
						fill="currentColor"
					>
						<path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd" />
					</svg>
				</button>

				{#if showRepoDropdown}
					<div class="absolute z-20 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto">
						<button
							type="button"
							onclick={() => handleRepoSelection('custom')}
							class="w-full px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 transition-colors {selectedRepoId === 'custom' ? 'bg-reindeer-green/10' : ''}"
						>
							<div class="flex items-center justify-between">
								<div>
									<div class="font-medium text-gray-900">Custom Repository</div>
									<div class="text-xs text-gray-500 mt-0.5">Enter your own repository URL</div>
								</div>
								{#if selectedRepoId === 'custom'}
									<svg class="w-5 h-5 text-reindeer-green" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
										<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
									</svg>
								{/if}
							</div>
						</button>
						{#each preConfiguredRepos as repo}
							<button
								type="button"
								onclick={() => handleRepoSelection(repo.id)}
								class="w-full px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0 transition-colors {selectedRepoId === repo.id ? 'bg-reindeer-green/10' : ''}"
							>
								<div class="flex items-center justify-between">
									<div class="flex-1">
										<div class="flex items-center gap-2">
											<span class="font-medium text-gray-900">{repo.name}</span>
										</div>
										<div class="text-xs text-gray-500 mt-0.5">
											Base branch: <span class="font-mono">{repo.baseBranch}</span>
										</div>
									</div>
									{#if selectedRepoId === repo.id}
										<svg class="w-5 h-5 text-reindeer-green flex-shrink-0 ml-2" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
											<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
										</svg>
									{/if}
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<!-- Repository URL (shown for custom or displays selected) -->
			<div>
				<label for="repository" class="block text-sm font-medium text-gray-700 mb-2">
					Repository URL <span class="text-red-500">*</span>
				</label>
				<input
					id="repository"
					type="text"
					bind:value={repository}
					placeholder="https://github.com/user/repo.git"
					readonly={selectedRepoId !== 'custom'}
					class="w-full px-4 py-3 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green {selectedRepoId !== 'custom' ? 'bg-gray-100' : ''}"
				/>
			</div>

			<!-- Base Branch -->
			<div>
				<label for="baseBranch" class="block text-sm font-medium text-gray-700 mb-2">
					Base Branch
				</label>
				<input
					id="baseBranch"
					type="text"
					bind:value={baseBranch}
					placeholder="main"
					class="w-full px-4 py-3 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green"
				/>
			</div>

			<!-- Task Source Toggle -->
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-2">
					Task Source <span class="text-red-500">*</span>
				</label>
				<div class="flex rounded-lg border border-gray-300 overflow-hidden">
					<button
						type="button"
						onclick={() => handleSourceChange('linear')}
						class="flex-1 px-4 py-2 text-sm font-medium transition-colors {taskSource === 'linear'
							? 'bg-reindeer-green text-white'
							: 'bg-gray-50 text-gray-600 hover:bg-gray-100'}"
					>
						Linear Ticket
					</button>
					<button
						type="button"
						onclick={() => handleSourceChange('manual')}
						class="flex-1 px-4 py-2 text-sm font-medium transition-colors {taskSource === 'manual'
							? 'bg-reindeer-green text-white'
							: 'bg-gray-50 text-gray-600 hover:bg-gray-100'}"
					>
						Manual Description
					</button>
				</div>
			</div>

			<!-- Linear Issue Search -->
			{#if taskSource === 'linear'}
				<div class="relative">
					<label for="linearSearch" class="block text-sm font-medium text-gray-700 mb-2">
						Search Linear Tickets
					</label>
					{#if linearError}
						<div class="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-yellow-700 text-sm mb-2">
							{linearError}
						</div>
					{:else}
						<div class="relative">
							<input
								id="linearSearch"
								type="text"
								bind:value={linearSearch}
								onfocus={() => showLinearDropdown = true}
								placeholder={loadingLinear ? 'Loading tickets...' : 'Search by ticket ID or title...'}
								disabled={loadingLinear}
								class="w-full px-4 py-3 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green disabled:opacity-50"
							/>
							{#if loadingLinear}
								<div class="absolute right-3 top-1/2 -translate-y-1/2">
									<div class="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-reindeer-green"></div>
								</div>
							{/if}
							{#if selectedLinearIssue}
								<button
									type="button"
									onclick={clearLinearSelection}
									class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
								>
									<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							{/if}
						</div>

						<!-- Dropdown -->
						{#if showLinearDropdown && !selectedLinearIssue && linearIssues.length > 0}
							<div class="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
								{#each getFilteredIssues() as issue}
									<button
										type="button"
										onclick={() => selectLinearIssue(issue)}
										class="w-full px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
									>
										<div class="flex items-center gap-2">
											<span class="font-medium text-reindeer-green">{issue.identifier}</span>
											<span
												class="px-2 py-0.5 text-xs rounded-full"
												style="background-color: {issue.state.color}20; color: {issue.state.color}"
											>
												{issue.state.name}
											</span>
										</div>
										<div class="text-sm text-gray-700 truncate mt-1">{issue.title}</div>
										{#if issue.project}
											<div class="text-xs text-gray-500 mt-1">{issue.project.name}</div>
										{/if}
									</button>
								{/each}
								{#if getFilteredIssues().length === 0}
									<div class="px-4 py-3 text-sm text-gray-500">No matching tickets found</div>
								{/if}
							</div>
						{/if}
					{/if}
				</div>

				<!-- Selected ticket preview -->
				{#if selectedLinearIssue}
					<div class="bg-reindeer-green/5 border border-reindeer-green/20 rounded-lg p-4">
						<div class="flex items-center gap-2 mb-2">
							<span class="font-semibold text-reindeer-green">{selectedLinearIssue.identifier}</span>
							<span
								class="px-2 py-0.5 text-xs rounded-full"
								style="background-color: {selectedLinearIssue.state.color}20; color: {selectedLinearIssue.state.color}"
							>
								{selectedLinearIssue.state.name}
							</span>
							<span class="text-xs text-gray-500">{priorityLabels[selectedLinearIssue.priority]}</span>
						</div>
						<div class="text-sm text-gray-900 font-medium">{selectedLinearIssue.title}</div>
						{#if selectedLinearIssue.description}
							<div class="text-sm text-gray-600 mt-2 line-clamp-3">{selectedLinearIssue.description}</div>
						{/if}
						<a
							href={selectedLinearIssue.url}
							target="_blank"
							rel="noopener noreferrer"
							class="text-xs text-reindeer-green hover:underline mt-2 inline-block"
						>
							View in Linear →
						</a>
					</div>
				{/if}
			{/if}

			<!-- Coding CLI -->
			<div>
				<label class="block text-sm font-medium text-gray-700 mb-3">
					AI Agent
				</label>
				<div class="grid grid-cols-3 gap-2">
					{#each cliOptions as option}
						<button
							type="button"
							onclick={() => !option.comingSoon && (codingCli = option.value as 'claude-code' | 'gemini' | 'codex')}
							disabled={option.comingSoon}
							class="p-2 rounded-lg border text-center transition-colors relative {option.comingSoon
								? 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed opacity-60'
								: codingCli === option.value
									? 'bg-reindeer-green/10 border-reindeer-green text-gray-900'
									: 'bg-gray-50 border-gray-300 text-gray-600 hover:border-gray-400'}"
						>
							{#if option.comingSoon}
								<span class="absolute -top-2 -right-2 px-1.5 py-0.5 text-[10px] font-medium bg-gray-200 text-gray-500 rounded-full">Soon</span>
							{/if}
							<span class="text-xl block mb-0.5">{option.icon}</span>
							<span class="text-xs font-medium">{option.label}</span>
						</button>
					{/each}
				</div>
			</div>
				</div>

				<!-- Right Column -->
				<div class="flex flex-col space-y-5 h-[600px]">

			<!-- Task Description (manual mode or shows Linear content) -->
			<div class="flex-1 flex flex-col">
				<label for="taskDescription" class="block text-sm font-medium text-gray-700 mb-2">
					Task Description {#if taskSource === 'manual'}<span class="text-red-500">*</span>{/if}
				</label>
				<textarea
					id="taskDescription"
					bind:value={taskDescription}
					placeholder={taskSource === 'linear' ? 'Select a Linear ticket above...' : 'Describe what you want the agent to do...'}
					readonly={taskSource === 'linear' && !!selectedLinearIssue}
					class="flex-1 w-full px-4 py-3 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green resize-none {taskSource === 'linear' && selectedLinearIssue ? 'bg-gray-100' : ''}"
				></textarea>
			</div>

			<!-- System Prompt -->
			<div>
				<label for="systemPrompt" class="block text-sm font-medium text-gray-700 mb-2">
					System Prompt
				</label>
				<textarea
					id="systemPrompt"
					bind:value={systemPrompt}
					placeholder="Instructions for the agent..."
					class="w-full h-32 px-4 py-3 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green resize-none text-sm"
				></textarea>
			</div>
				</div>
			</div>

			<!-- Actions -->
			<div class="flex gap-4 pt-6 border-t border-gray-200 mt-6">
				<button
					type="button"
					onclick={onclose}
					class="px-6 py-3 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={submitting || (taskSource === 'linear' && !selectedLinearIssue)}
					class="flex-1 px-8 py-3 text-lg bg-reindeer-green hover:bg-reindeer-green-dark hover:shadow-lg text-white font-semibold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
				>
					{#if submitting}
						<div class="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white"></div>
						<span>Creating...</span>
					{:else}
						<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
						</svg>
						<span>Create Task</span>
					{/if}
				</button>
			</div>
		</form>
	</div>
</div>
