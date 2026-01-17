<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import DashboardCard from '$lib/components/DashboardCard.svelte';
import type { DashboardMetrics } from '$lib/server/db';
import { authToken, initAuth0, isAuthenticated, user } from '$lib/stores/auth';

let loading = $state(true);
let error = $state<string | null>(null);
let metrics = $state<DashboardMetrics | null>(null);
let isAdmin = $state(false);
let pollInterval: ReturnType<typeof setInterval>;

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

const statusBgColors: Record<string, string> = {
	pending: 'bg-yellow-500',
	provisioning: 'bg-blue-500',
	initializing: 'bg-cyan-500',
	cloning: 'bg-blue-500',
	running: 'bg-green-500',
	completed: 'bg-emerald-500',
	failed: 'bg-red-500',
	stopped: 'bg-gray-500',
	deleted: 'bg-gray-300',
};

const cliIcons: Record<string, string> = {
	'claude-code': '🤖',
	gemini: '✨',
	codex: '💻',
};

async function fetchMetrics() {
	const token = $authToken;
	if (!token) return;

	try {
		const response = await fetch('/api/dashboard', {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (!response.ok) {
			throw new Error('Failed to fetch dashboard metrics');
		}

		const data = await response.json();
		metrics = data.metrics;
		isAdmin = data.isAdmin;
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

onMount(async () => {
	await initAuth0();
	await fetchMetrics();
	pollInterval = setInterval(fetchMetrics, 5000);
});

onDestroy(() => {
	if (pollInterval) clearInterval(pollInterval);
});
</script>

<div class="min-h-screen bg-reindeer-cream">
	<!-- Header -->
	<header class="bg-white border-b border-gray-200 px-6 py-4">
		<div class="max-w-7xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-3">
				<img src="/reindeer-logo-bot.png" alt="Reindeer" class="w-10 h-10 rounded-lg" />
				<h1 class="text-xl font-semibold text-gray-900">Reindeer Code</h1>
			</div>

			<div class="flex items-center gap-4">
				<a
					href="/"
					class="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 transition-colors"
				>
					Tasks
				</a>
				{#if $isAuthenticated}
					<span class="text-gray-600 text-sm">{$user?.email}</span>
				{/if}
			</div>
		</div>
	</header>

	<!-- Main Content -->
	<main class="max-w-7xl mx-auto px-6 py-8">
		{#if loading}
			<div class="flex items-center justify-center h-64">
				<div
					class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-reindeer-green"
				></div>
			</div>
		{:else if error}
			<div class="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
				{error}
			</div>
		{:else if metrics}
			<!-- Page Title -->
			<div class="mb-8">
				<h2 class="text-2xl font-semibold text-gray-900">
					{isAdmin ? 'Platform Dashboard' : 'Your Dashboard'}
				</h2>
				<p class="text-gray-500 text-sm mt-1">
					{isAdmin ? 'Overview of all tasks and users' : 'Overview of your tasks and activity'}
				</p>
			</div>

			<!-- Overview Cards -->
			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
				<DashboardCard title="Total Tasks" value={metrics.totalTasks} icon="📋" color="blue" />
				<DashboardCard
					title="Active Tasks"
					value={metrics.activeTasks}
					subtitle="Currently running"
					icon="⚡"
					color="green"
				/>
				<DashboardCard
					title="Success Rate"
					value="{metrics.successMetrics.completionRate}%"
					subtitle="{metrics.successMetrics.completed} completed"
					icon="✅"
					color="green"
				/>
				<DashboardCard
					title="Running VMs"
					value={metrics.runningVMs.length}
					subtitle="Active compute resources"
					icon="🖥️"
					color="blue"
				/>
			</div>

			<!-- Status & Agent Distribution -->
			<div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
				<!-- Status Breakdown -->
				<div class="bg-white rounded-xl border border-gray-200 p-6">
					<h3 class="text-lg font-medium text-gray-900 mb-4">Status Distribution</h3>
					{#if metrics.statusBreakdown.length === 0}
						<div class="text-center py-8 text-gray-400">
							<p class="text-sm">No tasks yet</p>
						</div>
					{:else}
						<div class="space-y-3">
							{#each metrics.statusBreakdown as status}
								<div>
									<div class="flex items-center justify-between mb-1">
										<span class="text-sm font-medium text-gray-700 capitalize"
											>{status.status}</span
										>
										<span class="text-sm text-gray-500"
											>{status.count} ({status.percentage}%)</span
										>
									</div>
									<div class="w-full bg-gray-100 rounded-full h-2">
										<div
											class="h-2 rounded-full {statusBgColors[status.status]}"
											style="width: {status.percentage}%"
										></div>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Agent Breakdown -->
				<div class="bg-white rounded-xl border border-gray-200 p-6">
					<h3 class="text-lg font-medium text-gray-900 mb-4">AI Agent Usage</h3>
					{#if metrics.agentBreakdown.length === 0}
						<div class="text-center py-8 text-gray-400">
							<p class="text-sm">No tasks yet</p>
						</div>
					{:else}
						<div class="space-y-4">
							{#each metrics.agentBreakdown as agent}
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-3">
										<span class="text-2xl">{cliIcons[agent.coding_cli]}</span>
										<span class="text-sm font-medium text-gray-700">{agent.coding_cli}</span>
									</div>
									<div class="text-right">
										<div class="text-lg font-semibold text-gray-900">{agent.count}</div>
										<div class="text-xs text-gray-500">{agent.percentage}%</div>
									</div>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>

			{#if isAdmin && metrics.userStats.mostActiveUsers.length > 0}
				<!-- User Stats (Admin Only) -->
				<div class="bg-white rounded-xl border border-gray-200 p-6 mb-8">
					<h3 class="text-lg font-medium text-gray-900 mb-4">User Activity</h3>
					<div class="mb-4">
						<span class="text-sm text-gray-500">Total Users: </span>
						<span class="text-lg font-semibold text-gray-900">{metrics.userStats.totalUsers}</span>
					</div>
					<div>
						<h4 class="text-sm font-medium text-gray-700 mb-3">Most Active Users</h4>
						<div class="space-y-2">
							{#each metrics.userStats.mostActiveUsers as activeUser}
								<div
									class="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
								>
									<span class="text-sm text-gray-700">{activeUser.user_email}</span>
									<span class="text-sm font-medium text-gray-900"
										>{activeUser.task_count} tasks</span
									>
								</div>
							{/each}
						</div>
					</div>
				</div>
			{/if}

			<!-- Recent Activity -->
			<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
				<!-- Latest Tasks -->
				<div class="bg-white rounded-xl border border-gray-200 p-6">
					<h3 class="text-lg font-medium text-gray-900 mb-4">Recent Tasks</h3>
					{#if metrics.recentActivity.latestTasks.length === 0}
						<div class="text-center py-8 text-gray-400">
							<p class="text-sm">No tasks yet</p>
						</div>
					{:else}
						<div class="space-y-3">
							{#each metrics.recentActivity.latestTasks as task}
								<a
									href="/tasks/{task.id}"
									class="block p-3 rounded-lg border border-gray-100 hover:border-reindeer-green hover:bg-reindeer-cream/30 transition-all"
								>
									<div class="flex items-start justify-between mb-2">
										<div class="flex items-center gap-2 flex-1 min-w-0">
											<span class="text-lg flex-shrink-0">{cliIcons[task.coding_cli]}</span>
											<span class="text-sm font-medium text-gray-700 line-clamp-1"
												>{task.task_description}</span
											>
										</div>
										<span
											class="px-2 py-1 text-xs font-medium rounded-full {statusColors[
												task.status
											]} whitespace-nowrap ml-2"
										>
											{task.status}
										</span>
									</div>
									<div class="flex items-center gap-2 text-xs text-gray-500">
										<span>{formatDate(task.created_at)}</span>
										<span class="text-gray-300">•</span>
										<span>{task.user_email}</span>
									</div>
								</a>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Recent Failures -->
				<div class="bg-white rounded-xl border border-gray-200 p-6">
					<h3 class="text-lg font-medium text-gray-900 mb-4">Recent Failures</h3>
					{#if metrics.recentActivity.recentFailures.length === 0}
						<div class="text-center py-8 text-gray-400">
							<div class="text-4xl mb-2">🎉</div>
							<p class="text-sm">No recent failures</p>
						</div>
					{:else}
						<div class="space-y-3">
							{#each metrics.recentActivity.recentFailures as task}
								<a
									href="/tasks/{task.id}"
									class="block p-3 rounded-lg border border-red-100 hover:border-red-300 hover:bg-red-50/30 transition-all"
								>
									<div class="flex items-start justify-between mb-2">
										<div class="flex items-center gap-2 flex-1 min-w-0">
											<span class="text-lg flex-shrink-0">{cliIcons[task.coding_cli]}</span>
											<span class="text-sm font-medium text-gray-700 line-clamp-1"
												>{task.task_description}</span
											>
										</div>
									</div>
									<div class="flex items-center gap-2 text-xs text-gray-500">
										<span>{formatDate(task.updated_at)}</span>
										<span class="text-gray-300">•</span>
										<span>{task.user_email}</span>
									</div>
								</a>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</main>
</div>
