<script lang="ts">
import { onMount } from 'svelte';
import CreateTaskModal from '$lib/components/CreateTaskModal.svelte';
import TaskList from '$lib/components/TaskList.svelte';
import { initAuth0, isAuthenticated, logout, user } from '$lib/stores/auth';

// Runtime env vars from layout server load
let { data } = $props();

let loading = $state(true);
let showCreateModal = $state(false);
let showUserDropdown = $state(false);

onMount(async () => {
	await initAuth0(true, data.env.DISABLE_AUTH);
	loading = false;
});
</script>

<div class="min-h-screen bg-reindeer-cream">
	<!-- Header -->
	<header class="bg-black border-b border-gray-800 px-6 py-4">
		<div class="max-w-7xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-3">
				<img src="/reindeer-logo-bot.png" alt="Reindeer" class="w-10 h-10 rounded-lg" />
				<h1 class="text-xl font-semibold text-white">Reindeer Code</h1>
			</div>

			{#if $isAuthenticated}
				<div class="flex items-center gap-4">
					<a
						href="/dashboard"
						class="px-2 py-2 text-white hover:text-gray-300 transition-colors"
						title="Dashboard"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
						</svg>
					</a>
					<a
						href="/config"
						class="px-2 py-2 text-white hover:text-gray-300 transition-colors"
						title="Configuration"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
						</svg>
					</a>
					<div class="relative">
						<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
						<button
							onclick={() => showUserDropdown = !showUserDropdown}
							class="flex items-center gap-2 text-white text-sm hover:text-gray-300 transition-colors"
						>
							<span>{$user?.email}</span>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								class="h-4 w-4 transition-transform {showUserDropdown ? 'rotate-180' : ''}"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
							</svg>
						</button>
						{#if showUserDropdown}
							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div
								class="absolute right-0 mt-2 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-lg z-50"
								onclick={(e) => e.stopPropagation()}
							>
								<button
									onclick={() => { logout(); showUserDropdown = false; }}
									class="w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-800 rounded-lg transition-colors"
								>
									Logout
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</header>

	<!-- Main Content -->
	<main class="max-w-7xl mx-auto px-6 py-8">
		{#if loading || !$isAuthenticated}
			<!-- Loading / Redirecting to login -->
			<div class="flex flex-col items-center justify-center h-[60vh] text-center">
				<img src="/reindeer-logo-bot.png" alt="Reindeer" class="w-24 h-24 rounded-2xl mb-6" />
				<div class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-reindeer-green mb-4"></div>
				<p class="text-gray-600">Redirecting to login...</p>
			</div>
		{:else}
			<!-- Dashboard -->
			<div class="flex items-center justify-end mb-6">
				<button
					onclick={() => showCreateModal = true}
					class="px-6 py-2.5 bg-reindeer-green hover:bg-reindeer-green-dark text-white font-medium rounded-lg transition-colors flex items-center gap-2"
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" />
					</svg>
					New Task
				</button>
			</div>

			<TaskList env={data.env} />
		{/if}
	</main>
</div>

{#if showCreateModal}
	<CreateTaskModal onclose={() => showCreateModal = false} />
{/if}
