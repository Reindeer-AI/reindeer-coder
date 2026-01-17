<script lang="ts">
import type { Task } from '$lib/server/db/schema';
import { authToken } from '$lib/stores/auth';

interface Props {
	task: Task;
	ondeleted?: () => void;
	env: {
		GCP_PROJECT_ID: string;
		VM_USER: string;
		GCP_ZONE: string;
	};
}

let { task, ondeleted, env }: Props = $props();

let deleting = $state(false);
let showCopiedModal = $state(false);

const statusColors: Record<string, string> = {
	pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
	provisioning: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
	cloning: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
	running: 'bg-green-500/20 text-green-400 border-green-500/50',
	completed: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50',
	failed: 'bg-red-500/20 text-red-400 border-red-500/50',
	stopped: 'bg-gray-500/20 text-gray-400 border-gray-500/50',
};

const cliLabels: Record<string, string> = {
	'claude-code': 'Claude Code',
	gemini: 'Gemini',
	codex: 'Codex',
};

async function deleteTask() {
	if (!confirm('Are you sure you want to delete this task?')) return;

	deleting = true;
	try {
		const response = await fetch(`/api/tasks/${task.id}`, {
			method: 'DELETE',
			headers: {
				Authorization: `Bearer ${$authToken}`,
			},
		});

		if (!response.ok) {
			throw new Error('Failed to delete task');
		}

		ondeleted?.();
	} catch (err) {
		alert(err instanceof Error ? err.message : 'Failed to delete task');
	} finally {
		deleting = false;
	}
}

function formatDate(dateStr: string | null): string {
	if (!dateStr) return '-';
	return new Date(dateStr).toLocaleString();
}

function extractRepoName(url: string): string {
	const match = url.match(/\/([^/]+?)(?:\.git)?$/);
	return match ? match[1] : url;
}

async function copySSHCommand() {
	if (!task || !task.vm_name) return;

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

async function copyBrowserTunnelCommand() {
	if (!task || !task.vm_name) return;

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
</script>

<a href="/tasks/{task.id}" class="block bg-vibe-dark rounded-xl border border-vibe-purple/20 overflow-hidden hover:border-vibe-purple/40 transition-colors">
	<!-- Header -->
	<div class="p-4 border-b border-vibe-purple/10">
		<div class="flex items-start justify-between">
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-3 mb-2">
					<span class="px-2.5 py-0.5 text-xs font-medium rounded-full border {statusColors[task.status] || statusColors.pending}">
						{task.status}
					</span>
					<span class="px-2.5 py-0.5 text-xs font-medium rounded-full bg-vibe-purple/20 text-vibe-purple-light border border-vibe-purple/50">
						{cliLabels[task.coding_cli] || task.coding_cli}
					</span>
				</div>
				<p class="text-white font-medium truncate">{task.task_description}</p>
				<div class="flex items-center gap-4 mt-2 text-sm text-gray-400">
					<span class="flex items-center gap-1">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
						</svg>
						{extractRepoName(task.repository)}
					</span>
					<span class="flex items-center gap-1">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
						</svg>
						{task.feature_branch}
					</span>
				</div>
			</div>

			<div class="flex items-center gap-2 ml-4">
				<button
					onclick={(e) => { e.preventDefault(); deleteTask(); }}
					disabled={deleting}
					class="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/20 rounded-lg transition-colors disabled:opacity-50"
					title="Delete task"
				>
					{#if deleting}
						<div class="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-current"></div>
					{:else}
						<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
						</svg>
					{/if}
				</button>
			</div>
		</div>
	</div>

	<!-- Connection Buttons Section (only show for running/cloning tasks with VM) -->
	{#if task.vm_name && ['running', 'cloning', 'initializing'].includes(task.status)}
		<div class="px-4 py-3 bg-vibe-darker/30 border-t border-vibe-purple/10 flex items-center gap-3">
			<button
				onclick={(e) => { e.preventDefault(); copySSHCommand(); }}
				class="flex-1 px-3 py-2 text-sm bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-lg transition-colors flex items-center justify-center gap-2"
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
				</svg>
				Connect from Terminal
			</button>
			<button
				onclick={(e) => { e.preventDefault(); copyBrowserTunnelCommand(); }}
				class="flex-1 px-3 py-2 text-sm bg-purple-500/10 hover:bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded-lg transition-colors flex items-center justify-center gap-2"
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
				</svg>
				Test from Local Browser
			</button>
		</div>
	{/if}

	<!-- Footer -->
	<div class="px-4 py-2 bg-vibe-darker/50 text-xs text-gray-500 flex items-center justify-between">
		<span>Created: {formatDate(task.created_at)}</span>
		{#if task.status === 'completed'}
			<span>Completed: {formatDate(task.updated_at)}</span>
		{/if}
	</div>
</a>

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
