<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { goto } from '$app/navigation';
import { page } from '$app/stores';
import Terminal from '$lib/components/Terminal.svelte';
import type { Task } from '$lib/server/db/schema';
import { authToken, initAuth0, isAuthenticated } from '$lib/stores/auth';

// Runtime env vars from layout server load
let { data } = $props();
const VM_USER = data.env.VM_USER;
const GCP_PROJECT_ID = data.env.GCP_PROJECT_ID;
const GCP_ZONE = data.env.GCP_ZONE;

interface ConnectionStatus {
	status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | null;
	tmuxSession?: string;
	lastActivity?: string;
}

let task = $state<Task | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let retrying = $state(false);
let reconnecting = $state(false);
let completing = $state(false);
let pollInterval: ReturnType<typeof setInterval>;
let connectionStatus = $state<ConnectionStatus>({ status: null });
let showCopiedModal = $state(false);

const statusColors: Record<string, string> = {
	pending: 'bg-yellow-100 text-yellow-700 border-yellow-300',
	provisioning: 'bg-blue-100 text-blue-700 border-blue-300',
	initializing: 'bg-cyan-100 text-cyan-700 border-cyan-300',
	cloning: 'bg-blue-100 text-blue-700 border-blue-300',
	running: 'bg-green-100 text-green-700 border-green-300',
	completed: 'bg-emerald-100 text-emerald-700 border-emerald-300',
	failed: 'bg-red-100 text-red-700 border-red-300',
	stopped: 'bg-gray-100 text-gray-700 border-gray-300',
	deleted: 'bg-gray-100 text-gray-400 border-gray-200',
};

const cliLabels: Record<string, string> = {
	'claude-code': 'Claude Code',
	gemini: 'Gemini',
	codex: 'Codex',
};

async function fetchTask() {
	const token = $authToken;
	if (!token) return;

	try {
		const response = await fetch(`/api/tasks/${$page.params.id}`, {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('Task not found');
			}
			throw new Error('Failed to fetch task');
		}

		const data = await response.json();
		task = data.task;
		error = null;
	} catch (err) {
		error = err instanceof Error ? err.message : 'Unknown error';
	} finally {
		loading = false;
	}
}

async function deleteTask() {
	if (!task || !confirm('Are you sure you want to delete this task?')) return;

	try {
		const response = await fetch(`/api/tasks/${task.id}`, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${$authToken}` },
		});

		if (!response.ok) {
			throw new Error('Failed to delete task');
		}

		goto('/');
	} catch (err) {
		alert(err instanceof Error ? err.message : 'Failed to delete task');
	}
}

async function retryTask() {
	if (!task) return;

	retrying = true;
	try {
		const response = await fetch(`/api/tasks/${task.id}`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${$authToken}` },
		});

		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.message || 'Failed to retry task');
		}

		// Refresh task data
		await fetchTask();
	} catch (err) {
		alert(err instanceof Error ? err.message : 'Failed to retry task');
	} finally {
		retrying = false;
	}
}

async function completeTask() {
	if (!task || !confirm('Mark this task as completed and delete all resources?')) return;

	completing = true;
	try {
		const response = await fetch(`/api/tasks/${task.id}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${$authToken}` },
		});

		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.message || 'Failed to complete task');
		}

		// Refresh task data
		await fetchTask();
	} catch (err) {
		alert(err instanceof Error ? err.message : 'Failed to complete task');
	} finally {
		completing = false;
	}
}

async function reconnectSSH() {
	if (!task) return;

	reconnecting = true;
	try {
		const response = await fetch(`/api/tasks/${task.id}/reconnect`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${$authToken}` },
		});

		const data = await response.json().catch(() => ({}));

		if (!response.ok) {
			throw new Error(data.message || 'Failed to reconnect');
		}
	} catch (err) {
		alert(err instanceof Error ? err.message : 'Failed to reconnect');
	} finally {
		reconnecting = false;
	}
}

function formatDate(dateStr: string | null): string {
	if (!dateStr) return '-';
	return new Date(dateStr).toLocaleString();
}

function handleConnectionChange(status: ConnectionStatus) {
	connectionStatus = status;
}

async function copySSHCommand() {
	if (!task || !task.vm_name) return;

	const project = GCP_PROJECT_ID;
	const zone = task.vm_zone || GCP_ZONE;

	// If we don't have the tmux session yet, derive it from task ID (same as orchestrator)
	const tmuxSession = connectionStatus.tmuxSession || `vibe-${task.id.slice(0, 8)}`;

	const sshCommand = `gcloud compute ssh ${task.vm_name} --project=${project} --zone=${zone} --tunnel-through-iap --ssh-flag="-t" -- sudo -u ${VM_USER} tmux attach-session -t ${tmuxSession}`;

	try {
		await navigator.clipboard.writeText(sshCommand);
		showCopiedModal = true;
		setTimeout(() => {
			showCopiedModal = false;
		}, 3000); // Hide after 3 seconds
	} catch (err) {
		alert('Failed to copy to clipboard');
	}
}

async function copyBrowserTunnelCommand() {
	if (!task || !task.vm_name) return;

	const project = GCP_PROJECT_ID;
	const zone = task.vm_zone || GCP_ZONE;

	const tunnelCommand = `gcloud compute ssh ${task.vm_name} --project=${project} --zone=${zone} --tunnel-through-iap -- -N -L 3715:127.0.0.1:5173`;

	try {
		await navigator.clipboard.writeText(tunnelCommand);
		showCopiedModal = true;
		setTimeout(() => {
			showCopiedModal = false;
		}, 3000); // Hide after 3 seconds
	} catch (err) {
		alert('Failed to copy to clipboard');
	}
}

async function copySshfsCommand() {
	if (!task || !task.vm_name) return;

	const project = GCP_PROJECT_ID;
	const zone = task.vm_zone || GCP_ZONE;
	const mountPoint = `~/vibe-mounts/${task.id}`;

	// Use gcloud compute start-iap-tunnel (works reliably with SSHFS)
	// Format matches the VS Code extension and manual testing
	const sshfsCommand = `mkdir -p ${mountPoint} && sshfs -o ProxyCommand="gcloud compute start-iap-tunnel ${task.vm_name} %p --listen-on-stdin --project=${project} --zone=${zone}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentityFile=~/.ssh/google_compute_engine ${VM_USER}@${task.vm_name}:/home/${VM_USER}/workspace ${mountPoint}`;

	try {
		await navigator.clipboard.writeText(sshfsCommand);
		showCopiedModal = true;
		setTimeout(() => {
			showCopiedModal = false;
		}, 3000); // Hide after 3 seconds
	} catch (err) {
		alert('Failed to copy to clipboard');
	}
}

const connectionStatusColors: Record<string, string> = {
	connecting: 'bg-yellow-100 text-yellow-700 border-yellow-300',
	connected: 'bg-green-100 text-green-700 border-green-300',
	disconnected: 'bg-red-100 text-red-700 border-red-300',
	reconnecting: 'bg-orange-100 text-orange-700 border-orange-300',
};

onMount(async () => {
	await initAuth0();
	await fetchTask();
	// Poll for status updates
	pollInterval = setInterval(fetchTask, 5000);
});

onDestroy(() => {
	if (pollInterval) clearInterval(pollInterval);
});
</script>

<div class="min-h-screen bg-reindeer-cream">
	<!-- Header -->
	<header class="bg-white border-b border-gray-200 px-6 py-4">
		<div class="max-w-7xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-4">
				<a href="/" class="flex items-center gap-3 text-gray-500 hover:text-gray-900 transition-colors">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
					</svg>
					<span>Back to Tasks</span>
				</a>
			</div>

			{#if task}
				<div class="flex items-center gap-2">
					{#if ['running', 'cloning', 'initializing'].includes(task.status)}
						<button
							onclick={completeTask}
							disabled={completing}
							class="px-4 py-2 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
						>
							{#if completing}
								<div class="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-emerald-600"></div>
							{:else}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
								</svg>
							{/if}
							Complete
						</button>
					{/if}
					{#if task.status !== 'pending'}
						<button
							onclick={retryTask}
							disabled={retrying}
							class="px-4 py-2 text-reindeer-green hover:text-reindeer-green-dark hover:bg-reindeer-green/10 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
						>
							{#if retrying}
								<div class="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-reindeer-green"></div>
							{:else}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
								</svg>
							{/if}
							Retry
						</button>
					{/if}
					<button
						onclick={deleteTask}
						class="px-4 py-2 text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors flex items-center gap-2"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
						</svg>
						Delete
					</button>
				</div>
			{/if}
		</div>
	</header>

	<!-- Main Content -->
	<main class="max-w-7xl mx-auto px-6 py-8">
		{#if loading}
			<div class="flex items-center justify-center h-64">
				<div class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-reindeer-green"></div>
			</div>
		{:else if error}
			<div class="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
				<p class="text-red-700 text-lg">{error}</p>
				<a href="/" class="mt-4 inline-block text-reindeer-green hover:text-reindeer-green-dark">
					Go back to dashboard
				</a>
			</div>
		{:else if task}
			<!-- Task Info -->
			<div class="bg-white rounded-xl border border-gray-200 p-6 mb-6">
				<div class="flex items-start justify-between mb-4">
					<div class="flex-1">
						<div class="flex items-center gap-3 mb-2">
							<span class="px-3 py-1 text-sm font-medium rounded-full border {statusColors[task.status]}">
								{task.status}
							</span>
							<span class="px-3 py-1 text-sm font-medium rounded-full bg-reindeer-green/10 text-reindeer-green border border-reindeer-green/30">
								{cliLabels[task.coding_cli]}
							</span>
						</div>

						{#if task.metadata?.linear?.issue_identifier && task.metadata?.linear?.issue_url}
							<!-- Linear ticket display -->
							<div class="flex items-center gap-2 mb-2">
								<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
								</svg>
								<a
									href={task.metadata?.linear?.issue_url}
									target="_blank"
									rel="noopener noreferrer"
									class="text-xl font-semibold text-reindeer-green hover:text-reindeer-green-dark hover:underline flex items-center gap-1"
								>
									{task.metadata?.linear?.issue_identifier}: {task.metadata?.linear?.issue_title || 'Linear Ticket'}
									<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
									</svg>
								</a>
							</div>
							<!-- Full task description (collapsible for long descriptions) -->
							{#if task.task_description.length > 300}
								<details class="mt-3">
									<summary class="cursor-pointer text-sm text-gray-600 hover:text-gray-900 select-none">
										View full task description
									</summary>
									<div class="mt-2 p-3 bg-gray-50 rounded-lg text-sm text-gray-700 whitespace-pre-wrap max-h-96 overflow-y-auto">
										{task.task_description}
									</div>
								</details>
							{:else}
								<div class="mt-2 text-sm text-gray-700 whitespace-pre-wrap">
									{task.task_description}
								</div>
							{/if}
						{:else}
							<!-- Manual task display -->
							<h1 class="text-2xl font-semibold text-gray-900">
								{task.task_description.split('\n')[0].replace(/^#+ /, '')}
							</h1>
							{#if task.task_description.split('\n').length > 1}
								<div class="mt-2 text-sm text-gray-700 whitespace-pre-wrap">
									{task.task_description.split('\n').slice(1).join('\n')}
								</div>
							{/if}
						{/if}
					</div>
				</div>

				<div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
					<div>
						<span class="text-gray-500 block mb-1">Repository</span>
						<span class="text-gray-900 break-all">{task.repository}</span>
					</div>
					<div>
						<span class="text-gray-500 block mb-1">Branch</span>
						<span class="text-gray-900">{task.feature_branch || task.base_branch}</span>
					</div>
					<div>
						<span class="text-gray-500 block mb-1">Created</span>
						<span class="text-gray-900">{formatDate(task.created_at)}</span>
					</div>
					<div>
						<span class="text-gray-500 block mb-1">Requested by</span>
						<span class="text-gray-900">{task.user_email}</span>
					</div>
					<div>
						<span class="text-gray-500 block mb-1">VM Name</span>
						<span class="text-gray-900">{task.vm_name || '-'}</span>
					</div>
				</div>
			</div>

			<!-- Terminal -->
			<div class="bg-white rounded-xl border border-gray-200 overflow-hidden mb-6">
				<div class="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
					<div class="flex items-center gap-3">
						<h2 class="text-lg font-medium text-gray-900">Terminal</h2>
						{#if task.status === 'running' && connectionStatus.status === 'connected'}
							<span class="text-xs text-gray-500">Click to type</span>
						{/if}
						{#if task.vm_name && ['running', 'cloning'].includes(task.status) && (connectionStatus.status === 'disconnected' || connectionStatus.status === null)}
							<button
								onclick={reconnectSSH}
								disabled={reconnecting}
								class="px-3 py-1 text-sm bg-reindeer-green/10 hover:bg-reindeer-green/20 text-reindeer-green border border-reindeer-green/30 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
							>
								{#if reconnecting}
									<div class="animate-spin rounded-full h-3 w-3 border-t-2 border-b-2 border-reindeer-green"></div>
									Reconnecting...
								{:else}
									<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
									</svg>
									Reconnect SSH
								{/if}
							</button>
						{/if}
						{#if task.vm_name && ['running', 'cloning'].includes(task.status)}
							<button
								onclick={copySSHCommand}
								class="px-3 py-1 text-sm bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 border border-blue-500/30 rounded-lg transition-colors flex items-center gap-2"
							>
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
								</svg>
								Connect from Terminal
							</button>
							<button
								onclick={copyBrowserTunnelCommand}
								class="px-3 py-1 text-sm bg-purple-500/10 hover:bg-purple-500/20 text-purple-600 border border-purple-500/30 rounded-lg transition-colors flex items-center gap-2"
							>
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
								</svg>
								Test from Local Browser
							</button>
							<button
								onclick={copySshfsCommand}
								class="px-3 py-1 text-sm bg-orange-500/10 hover:bg-orange-500/20 text-orange-600 border border-orange-500/30 rounded-lg transition-colors flex items-center gap-2"
							>
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
								</svg>
								Mount via SSHFS
							</button>
						{/if}
					</div>
					{#if connectionStatus.status}
						<div class="flex items-center gap-2">
							<span class="px-2 py-1 text-xs font-medium rounded-full border {connectionStatusColors[connectionStatus.status] || 'bg-gray-100 text-gray-500 border-gray-300'}">
								{#if connectionStatus.status === 'connected'}
									<span class="inline-block w-2 h-2 bg-green-500 rounded-full mr-1 animate-pulse"></span>
								{:else if connectionStatus.status === 'reconnecting'}
									<span class="inline-block w-2 h-2 bg-orange-500 rounded-full mr-1 animate-spin"></span>
								{:else if connectionStatus.status === 'disconnected'}
									<span class="inline-block w-2 h-2 bg-red-500 rounded-full mr-1"></span>
								{:else}
									<span class="inline-block w-2 h-2 bg-yellow-500 rounded-full mr-1 animate-pulse"></span>
								{/if}
								SSH: {connectionStatus.status}
							</span>
							{#if connectionStatus.tmuxSession}
								<span class="px-2 py-1 text-xs font-medium rounded-full bg-reindeer-green/10 text-reindeer-green border border-reindeer-green/30">
									tmux: {connectionStatus.tmuxSession}
								</span>
							{/if}
						</div>
					{/if}
				</div>
				<Terminal taskId={task.id} onConnectionChange={handleConnectionChange} />
			</div>
		{/if}
	</main>

	<!-- Copied to clipboard modal -->
	{#if showCopiedModal}
		<div class="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
			<div class="bg-gray-900 text-white px-6 py-4 rounded-lg shadow-2xl flex items-center gap-3 animate-fade-in pointer-events-auto">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
				</svg>
				<span class="text-lg">copied to clipboard, don't forget 🕋</span>
			</div>
		</div>
	{/if}
</div>

<style>
	@keyframes fade-in {
		from {
			opacity: 0;
			transform: translateY(-10px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.animate-fade-in {
		animation: fade-in 0.3s ease-out;
	}
</style>
