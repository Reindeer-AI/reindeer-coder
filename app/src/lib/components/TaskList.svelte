<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import type { Task } from '$lib/server/db/schema';
import { authToken, user } from '$lib/stores/auth';

// Runtime env vars passed from parent
interface Props {
	env: {
		GCP_PROJECT_ID: string;
		VM_USER: string;
		GCP_ZONE: string;
	};
}
let { env }: Props = $props();

interface TaskWithExtras extends Task {
	needsAttention?: boolean;
}

let tasks = $state<TaskWithExtras[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let pollInterval: ReturnType<typeof setInterval>;
let filterStatus = $state<'running' | 'all'>('running');
let filterOwnership = $state<'mine' | 'anyone'>('mine');
let showCopiedModal = $state(false);

async function copySSHCommand(task: TaskWithExtras, event: Event) {
	event.preventDefault();
	event.stopPropagation();
	if (!task.vm_name) return;

	const project = env.GCP_PROJECT_ID;
	const zone = task.vm_zone || env.GCP_ZONE;
	const tmuxSession = `vibe-${task.id.slice(0, 8)}`;

	const sshCommand = `gcloud compute ssh ${task.vm_name} --project=${project} --zone=${zone} --tunnel-through-iap --ssh-flag="-t" -- sudo -u ${env.VM_USER} tmux attach-session -t ${tmuxSession}`;

	try {
		await navigator.clipboard.writeText(sshCommand);
		showCopiedModal = true;
		setTimeout(() => {
			showCopiedModal = false;
		}, 3000);
	} catch {
		alert('Failed to copy to clipboard');
	}
}

async function copyBrowserTunnelCommand(task: TaskWithExtras, event: Event) {
	event.preventDefault();
	event.stopPropagation();
	if (!task.vm_name) return;

	const project = env.GCP_PROJECT_ID;
	const zone = task.vm_zone || env.GCP_ZONE;

	const tunnelCommand = `gcloud compute ssh ${task.vm_name} --project=${project} --zone=${zone} --tunnel-through-iap -- -N -L 3715:127.0.0.1:5173`;

	try {
		await navigator.clipboard.writeText(tunnelCommand);
		showCopiedModal = true;
		setTimeout(() => {
			showCopiedModal = false;
		}, 3000);
	} catch {
		alert('Failed to copy to clipboard');
	}
}

const statusColors: Record<string, string> = {
	pending: 'bg-yellow-100 text-yellow-700',
	provisioning: 'bg-blue-100 text-blue-700',
	initializing: 'bg-cyan-100 text-cyan-700',
	cloning: 'bg-blue-100 text-blue-700',
	running: 'bg-green-100 text-green-700',
	completed: 'bg-emerald-100 text-emerald-700',
	failed: 'bg-red-100 text-red-700',
	stopped: 'bg-gray-100 text-gray-700',
	deleted: 'bg-gray-100 text-gray-400',
};

const cliIcons: Record<string, string> = {
	'claude-code': '🤖',
	gemini: '✨',
	codex: '💻',
};

let filteredTasks = $derived(
	tasks.filter((task) => {
		// Apply status filter
		if (filterStatus === 'running' && task.status !== 'running') {
			return false;
		}

		// Apply ownership filter
		if (filterOwnership === 'mine' && $user?.email && task.user_email !== $user.email) {
			return false;
		}

		return true;
	})
);

async function fetchTasks() {
	const token = $authToken;
	if (!token) return;

	try {
		const response = await fetch('/api/tasks', {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) {
			throw new Error('Failed to fetch tasks');
		}

		const data = await response.json();
		tasks = data.tasks;
		error = null;
	} catch (err) {
		error = err instanceof Error ? err.message : 'Unknown error';
	} finally {
		loading = false;
	}
}

function formatDate(dateStr: string): string {
	const date = new Date(dateStr);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return 'just now';
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	return `${diffDays}d ago`;
}

onMount(() => {
	fetchTasks();
	pollInterval = setInterval(fetchTasks, 10000);
});

onDestroy(() => {
	if (pollInterval) clearInterval(pollInterval);
});
</script>

{#if loading}
	<div class="flex items-center justify-center h-48">
		<div class="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-reindeer-green"></div>
	</div>
{:else if error}
	<div class="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
		{error}
	</div>
{:else}
	<!-- Filter buttons - always show when not loading/error -->
	{#if tasks.length > 0}
		<div class="mb-4 flex flex-col sm:flex-row gap-3">
			<!-- Ownership Filter -->
			<div class="flex gap-2">
				<button
					class="px-3 py-1.5 text-sm rounded-lg {filterOwnership === 'mine'
						? 'bg-reindeer-green text-white'
						: 'bg-gray-100 text-gray-700 hover:bg-gray-200'}"
					onclick={() => filterOwnership = 'mine'}
				>
					Your Tasks
				</button>
				<button
					class="px-3 py-1.5 text-sm rounded-lg {filterOwnership === 'anyone'
						? 'bg-reindeer-green text-white'
						: 'bg-gray-100 text-gray-700 hover:bg-gray-200'}"
					onclick={() => filterOwnership = 'anyone'}
				>
					Tasks Owned by Anyone
				</button>
			</div>

			<!-- Status Filter -->
			<div class="flex gap-2">
				<button
					class="px-3 py-1.5 text-sm rounded-lg {filterStatus === 'running'
						? 'bg-blue-500 text-white'
						: 'bg-gray-100 text-gray-700 hover:bg-gray-200'}"
					onclick={() => filterStatus = 'running'}
				>
					Running Only
				</button>
				<button
					class="px-3 py-1.5 text-sm rounded-lg {filterStatus === 'all'
						? 'bg-blue-500 text-white'
						: 'bg-gray-100 text-gray-700 hover:bg-gray-200'}"
					onclick={() => filterStatus = 'all'}
				>
					All Tasks
				</button>
			</div>
		</div>
	{/if}

	{#if filteredTasks.length === 0}
		<div class="text-center py-16">
			<div class="w-16 h-16 bg-white rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-sm">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
				</svg>
			</div>
			<h3 class="text-xl font-medium text-gray-900 mb-2">
				{#if filterStatus === 'running' && filterOwnership === 'mine'}
					No running tasks owned by you
				{:else if filterStatus === 'running'}
					No running tasks
				{:else if filterOwnership === 'mine'}
					No tasks owned by you
				{:else}
					No tasks yet
				{/if}
			</h3>
			<p class="text-gray-500">
				{#if filterOwnership === 'mine' && filterStatus === 'running'}
					Try switching to "All Tasks" or "Tasks Owned by Anyone" to see more
				{:else if filterOwnership === 'mine'}
					Try switching to "Tasks Owned by Anyone" to see all tasks
				{:else if filterStatus === 'running'}
					Switch to "All Tasks" to see completed and failed tasks
				{:else}
					Create your first coding task to get started
				{/if}
			</p>
		</div>
	{:else}
		<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
			{#each filteredTasks as task}
			<a
				href="/tasks/{task.id}"
				class="block bg-white rounded-xl border border-gray-200 p-5 hover:border-reindeer-green-light hover:shadow-sm transition-all relative"
			>
				<div class="flex items-center gap-3 mb-3">
					<span class="text-2xl">{cliIcons[task.coding_cli]}</span>
					<div class="min-w-0">
						<h3 class="text-gray-900 font-medium line-clamp-1">{task.task_description}</h3>
						<p class="text-gray-500 text-sm truncate">{task.repository}</p>
					</div>
				</div>
				<div class="flex items-center flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
					<span>{formatDate(task.created_at)}</span>
					<span class="text-gray-300">•</span>
					<span>{task.base_branch}</span>
					<span class="text-gray-300">•</span>
					<span>{task.user_email}</span>
					<span class="text-gray-300">•</span>
					<span class="px-2 py-0.5 text-xs font-medium rounded-full {statusColors[task.status]}">
						{task.status}
					</span>
					{#if task.needsAttention}
						<span class="px-2 py-0.5 text-xs font-medium rounded-full bg-yellow-100 text-yellow-700 border border-yellow-300">
							Needs Attention
						</span>
					{/if}
				</div>
				{#if task.vm_name && ['running', 'cloning', 'initializing'].includes(task.status)}
					<div class="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2">
						<button
							onclick={(e) => copySSHCommand(task, e)}
							class="flex-1 px-3 py-1.5 text-xs bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200 rounded-lg transition-colors flex items-center justify-center gap-1.5"
						>
							<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
							</svg>
							Connect from Terminal
						</button>
						<button
							onclick={(e) => copyBrowserTunnelCommand(task, e)}
							class="flex-1 px-3 py-1.5 text-xs bg-purple-50 hover:bg-purple-100 text-purple-600 border border-purple-200 rounded-lg transition-colors flex items-center justify-center gap-1.5"
						>
							<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
							</svg>
							Test from Browser
						</button>
					</div>
				{/if}
			</a>
		{/each}
		</div>
	{/if}
{/if}

{#if showCopiedModal}
	<div class="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
		<div class="bg-gray-900 text-white px-6 py-4 rounded-lg shadow-2xl flex items-center gap-3 animate-fade-in pointer-events-auto">
			<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
			</svg>
			<span class="text-lg">Copied to clipboard</span>
		</div>
	</div>
{/if}

<style>
	@keyframes fade-in {
		from { opacity: 0; transform: translateY(-10px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.animate-fade-in {
		animation: fade-in 0.3s ease-out;
	}
</style>
