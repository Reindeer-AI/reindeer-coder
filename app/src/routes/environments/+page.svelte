<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { getAuthHeaders, initAuth0, isAuthenticated, logout, user } from '$lib/stores/auth';

let { data } = $props();

let loading = $state(true);
let showUserDropdown = $state(false);

// Specs
let specs = $state<any[]>([]);
let specsLoading = $state(false);
let showSpecModal = $state(false);
let editingSpec = $state<any>(null);
let specName = $state('');
let specJson = $state('{\n  "image": "ubuntu:22.04"\n}');
let specError = $state('');
let specSaving = $state(false);

// Environments
let environments = $state<any[]>([]);
let envsLoading = $state(false);
let showCreateEnvModal = $state(false);
let selectedSpecId = $state('');
let envName = $state('');
let machineTypeOverride = $state('');
let envError = $state('');
let envCreating = $state(false);

// Toast
let toastMessage = $state('');
let toastTimeout: ReturnType<typeof setTimeout> | null = null;

function showToast(msg: string) {
	toastMessage = msg;
	if (toastTimeout) clearTimeout(toastTimeout);
	toastTimeout = setTimeout(() => {
		toastMessage = '';
	}, 3000);
}

const statusColors: Record<string, string> = {
	pending: 'bg-yellow-100 text-yellow-700',
	provisioning: 'bg-blue-100 text-blue-700',
	ready: 'bg-green-100 text-green-700',
	stopped: 'bg-gray-100 text-gray-700',
	failed: 'bg-red-100 text-red-700',
	deleted: 'bg-gray-50 text-gray-400',
};

async function fetchSpecs() {
	specsLoading = true;
	try {
		const res = await fetch('/api/specs', { headers: getAuthHeaders() });
		if (res.ok) {
			const data = await res.json();
			specs = data.specs;
		}
	} catch (err) {
		console.error('Failed to fetch specs:', err);
	} finally {
		specsLoading = false;
	}
}

async function fetchEnvironments() {
	envsLoading = true;
	try {
		const res = await fetch('/api/environments', { headers: getAuthHeaders() });
		if (res.ok) {
			const data = await res.json();
			environments = data.environments;
		}
	} catch (err) {
		console.error('Failed to fetch environments:', err);
	} finally {
		envsLoading = false;
	}
}

async function saveSpec() {
	specError = '';
	try {
		JSON.parse(specJson);
	} catch {
		specError = 'Invalid JSON';
		return;
	}
	if (!specName.trim()) {
		specError = 'Name is required';
		return;
	}

	specSaving = true;
	try {
		const url = editingSpec ? `/api/specs/${editingSpec.id}` : '/api/specs';
		const method = editingSpec ? 'PUT' : 'POST';
		const res = await fetch(url, {
			method,
			headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
			body: JSON.stringify({ name: specName, devcontainer_json: specJson }),
		});
		if (!res.ok) {
			const data = await res.json();
			specError = data.message || 'Failed to save spec';
			return;
		}
		closeSpecModal();
		await fetchSpecs();
		showToast(editingSpec ? 'Spec updated' : 'Spec created');
	} catch (err) {
		specError = 'Network error';
	} finally {
		specSaving = false;
	}
}

async function deleteSpec(id: string, name: string) {
	if (!confirm(`Delete spec "${name}"?`)) return;
	try {
		const res = await fetch(`/api/specs/${id}`, {
			method: 'DELETE',
			headers: getAuthHeaders(),
		});
		if (!res.ok) {
			const data = await res.json();
			alert(data.message || 'Failed to delete spec');
			return;
		}
		await fetchSpecs();
		showToast('Spec deleted');
	} catch {
		alert('Network error');
	}
}

async function editSpec(spec: any) {
	editingSpec = spec;
	specName = spec.name;
	specError = '';
	specJson = ''; // will be loaded
	showSpecModal = true;
	try {
		const res = await fetch(`/api/specs/${spec.id}`, { headers: getAuthHeaders() });
		if (res.ok) {
			const data = await res.json();
			specJson =
				typeof data.spec.devcontainer_json === 'string'
					? data.spec.devcontainer_json
					: JSON.stringify(data.spec.devcontainer_json, null, 2);
		}
	} catch {
		specError = 'Failed to load spec content';
	}
}

function openNewSpec() {
	editingSpec = null;
	specName = '';
	specJson = '{\n  "image": "ubuntu:22.04"\n}';
	specError = '';
	showSpecModal = true;
}

function closeSpecModal() {
	showSpecModal = false;
	editingSpec = null;
	specName = '';
	specJson = '';
	specError = '';
}

async function createEnvironment() {
	envError = '';
	if (!selectedSpecId) {
		envError = 'Select a spec';
		return;
	}
	envCreating = true;
	try {
		const body: any = { spec_id: selectedSpecId };
		if (envName.trim()) body.name = envName.trim();
		if (machineTypeOverride.trim()) body.machine_type = machineTypeOverride.trim();

		const res = await fetch('/api/environments', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const data = await res.json();
			envError = data.message || 'Failed to create environment';
			return;
		}
		closeEnvModal();
		await fetchEnvironments();
		showToast('Environment created — provisioning started');
	} catch {
		envError = 'Network error';
	} finally {
		envCreating = false;
	}
}

function closeEnvModal() {
	showCreateEnvModal = false;
	selectedSpecId = '';
	envName = '';
	machineTypeOverride = '';
	envError = '';
}

async function stopEnvironment(id: string) {
	try {
		const res = await fetch(`/api/environments/${id}/stop`, {
			method: 'POST',
			headers: getAuthHeaders(),
		});
		if (!res.ok) {
			const data = await res.json();
			alert(data.message || 'Failed to stop');
			return;
		}
		await fetchEnvironments();
		showToast('Environment stopped');
	} catch {
		alert('Network error');
	}
}

async function startEnvironment(id: string) {
	try {
		const res = await fetch(`/api/environments/${id}/start`, {
			method: 'POST',
			headers: getAuthHeaders(),
		});
		if (!res.ok) {
			const data = await res.json();
			alert(data.message || 'Failed to start');
			return;
		}
		await fetchEnvironments();
		showToast('Environment starting...');
	} catch {
		alert('Network error');
	}
}

async function deleteEnvironment(id: string, name: string) {
	if (!confirm(`Delete environment "${name}"? This will destroy the VM.`)) return;
	try {
		const res = await fetch(`/api/environments/${id}`, {
			method: 'DELETE',
			headers: getAuthHeaders(),
		});
		if (!res.ok) {
			const data = await res.json();
			alert(data.message || 'Failed to delete');
			return;
		}
		await fetchEnvironments();
		showToast('Environment deleted');
	} catch {
		alert('Network error');
	}
}

function copySshCommand(cmd: string) {
	navigator.clipboard.writeText(cmd);
	showToast('SSH command copied to clipboard');
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

onMount(async () => {
	await initAuth0(true, data.env.DISABLE_AUTH);
	loading = false;
	await Promise.all([fetchSpecs(), fetchEnvironments()]);
	pollInterval = setInterval(fetchEnvironments, 10000);
});

onDestroy(() => {
	if (pollInterval) clearInterval(pollInterval);
	if (toastTimeout) clearTimeout(toastTimeout);
});
</script>

<div class="min-h-screen bg-reindeer-cream">
	<!-- Header (same structure as main page) -->
	<header class="bg-black border-b border-gray-800 px-6 py-4">
		<div class="max-w-7xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-3">
				<a href="/" class="flex items-center gap-3">
					<img src="/reindeer-logo-bot.png" alt="Reindeer" class="w-10 h-10 rounded-lg" />
					<h1 class="text-xl font-semibold text-white">Reindeer Code</h1>
				</a>
			</div>

			{#if $isAuthenticated}
				<div class="flex items-center gap-4">
					<a href="/" class="px-2 py-2 text-gray-400 hover:text-white transition-colors" title="Tasks">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
						</svg>
					</a>
					<a href="/environments" class="px-2 py-2 text-white transition-colors" title="Environments">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
						</svg>
					</a>
					<a href="/dashboard" class="px-2 py-2 text-gray-400 hover:text-white transition-colors" title="Dashboard">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
						</svg>
					</a>
					<a href="/config" class="px-2 py-2 text-gray-400 hover:text-white transition-colors" title="Configuration">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
						</svg>
					</a>
					<div class="relative">
						<button
							onclick={() => showUserDropdown = !showUserDropdown}
							class="flex items-center gap-2 text-white text-sm hover:text-gray-300 transition-colors"
						>
							<span>{$user?.email}</span>
						</button>
						{#if showUserDropdown}
							<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
							<div class="absolute right-0 mt-2 w-48 bg-gray-900 border border-gray-700 rounded-lg shadow-lg z-50" onclick={(e) => e.stopPropagation()}>
								<button onclick={() => { logout(); showUserDropdown = false; }} class="w-full px-4 py-2 text-left text-sm text-white hover:bg-gray-800 rounded-lg transition-colors">
									Logout
								</button>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</header>

	<main class="max-w-7xl mx-auto px-6 py-8">
		{#if loading || !$isAuthenticated}
			<div class="flex items-center justify-center py-20">
				<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-reindeer-green"></div>
			</div>
		{:else}
			<!-- Specs Section -->
			<section class="mb-10">
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-gray-900">Specs</h2>
					<button
						onclick={openNewSpec}
						class="flex items-center gap-2 px-4 py-2 bg-reindeer-green text-white rounded-lg hover:bg-reindeer-green-dark transition-colors text-sm font-medium"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
						</svg>
						New Spec
					</button>
				</div>

				{#if specsLoading && specs.length === 0}
					<div class="text-center py-8 text-gray-500 text-sm">Loading specs...</div>
				{:else if specs.length === 0}
					<div class="bg-white rounded-xl border border-gray-200 p-8 text-center">
						<p class="text-gray-500 text-sm">No specs yet. Create a devcontainer spec to get started.</p>
					</div>
				{:else}
					<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
						{#each specs as spec}
							<div class="bg-white rounded-xl border border-gray-200 p-4 hover:border-reindeer-green-light hover:shadow-sm transition-all">
								<div class="flex items-start justify-between">
									<div class="min-w-0 flex-1">
										<h3 class="font-medium text-gray-900 truncate">{spec.name}</h3>
										<p class="text-xs text-gray-400 mt-1">
											Created {new Date(spec.created_at).toLocaleDateString()}
										</p>
									</div>
									<div class="flex items-center gap-1 ml-2 shrink-0">
										<button
											onclick={() => editSpec(spec)}
											class="p-1.5 text-gray-400 hover:text-reindeer-green transition-colors rounded"
											title="Edit"
										>
											<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
											</svg>
										</button>
										<button
											onclick={() => deleteSpec(spec.id, spec.name)}
											class="p-1.5 text-gray-400 hover:text-red-500 transition-colors rounded"
											title="Delete"
										>
											<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
											</svg>
										</button>
									</div>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<!-- Environments Section -->
			<section>
				<div class="flex items-center justify-between mb-4">
					<h2 class="text-lg font-semibold text-gray-900">Environments</h2>
					<button
						onclick={() => { showCreateEnvModal = true; }}
						disabled={specs.length === 0}
						class="flex items-center gap-2 px-4 py-2 bg-reindeer-green text-white rounded-lg hover:bg-reindeer-green-dark transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
						</svg>
						New Environment
					</button>
				</div>

				{#if envsLoading && environments.length === 0}
					<div class="text-center py-8 text-gray-500 text-sm">Loading environments...</div>
				{:else if environments.length === 0}
					<div class="bg-white rounded-xl border border-gray-200 p-8 text-center">
						<p class="text-gray-500 text-sm">
							{specs.length === 0
								? 'Create a spec first, then spin up an environment from it.'
								: 'No environments yet. Spin one up from a spec.'}
						</p>
					</div>
				{:else}
					<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
						{#each environments as env}
							<div class="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-sm transition-all">
								<div class="flex items-start justify-between mb-3">
									<div class="min-w-0 flex-1">
										<h3 class="font-medium text-gray-900 truncate">{env.name}</h3>
										<p class="text-xs text-gray-400 mt-0.5">
											{env.vm_machine_type || 'pending'} &middot; {env.vm_zone || '—'}
										</p>
									</div>
									<span class="px-2.5 py-0.5 text-xs font-medium rounded-full {statusColors[env.status] || 'bg-gray-100 text-gray-700'}">
										{env.status}
									</span>
								</div>

								<!-- Connection info -->
								{#if env.status === 'ready' && env.connection_info?.ssh_command}
									<div class="bg-gray-50 rounded-lg p-3 mb-3">
										<div class="flex items-center justify-between">
											<code class="text-xs text-gray-600 truncate flex-1 mr-2">{env.connection_info.ssh_command}</code>
											<button
												onclick={() => copySshCommand(env.connection_info.ssh_command)}
												class="shrink-0 px-2 py-1 text-xs bg-reindeer-green text-white rounded hover:bg-reindeer-green-dark transition-colors"
											>
												Copy
											</button>
										</div>
									</div>
								{/if}

								<!-- Actions -->
								<div class="flex items-center gap-2">
									{#if env.status === 'ready'}
										<button
											onclick={() => stopEnvironment(env.id)}
											class="px-3 py-1.5 text-xs font-medium text-yellow-700 bg-yellow-50 rounded-lg hover:bg-yellow-100 transition-colors"
										>
											Stop
										</button>
									{/if}
									{#if env.status === 'stopped'}
										<button
											onclick={() => startEnvironment(env.id)}
											class="px-3 py-1.5 text-xs font-medium text-green-700 bg-green-50 rounded-lg hover:bg-green-100 transition-colors"
										>
											Start
										</button>
									{/if}
									{#if env.status !== 'provisioning'}
										<button
											onclick={() => deleteEnvironment(env.id, env.name)}
											class="px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100 transition-colors"
										>
											Delete
										</button>
									{/if}
									<span class="text-xs text-gray-400 ml-auto">
										{new Date(env.created_at).toLocaleDateString()}
									</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		{/if}
	</main>
</div>

<!-- Spec Create/Edit Modal -->
{#if showSpecModal}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onclick={closeSpecModal}>
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden shadow-2xl flex flex-col" onclick={(e) => e.stopPropagation()}>
			<div class="p-6 border-b border-gray-200 bg-gray-50">
				<h2 class="text-lg font-semibold text-gray-900">{editingSpec ? 'Edit Spec' : 'New Spec'}</h2>
				<p class="text-gray-500 text-sm mt-1">Define a devcontainer.json for your environments</p>
			</div>

			<div class="p-6 flex-1 overflow-y-auto space-y-4">
				{#if specError}
					<div class="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">{specError}</div>
				{/if}

				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1" for="spec-name">Name</label>
					<input
						id="spec-name"
						type="text"
						bind:value={specName}
						placeholder="e.g. python-ml, go-backend"
						class="w-full px-4 py-2.5 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green text-sm"
					/>
				</div>

				<div class="flex-1">
					<label class="block text-sm font-medium text-gray-700 mb-1" for="spec-json">devcontainer.json</label>
					<textarea
						id="spec-json"
						bind:value={specJson}
						rows="16"
						spellcheck="false"
						class="w-full px-4 py-3 bg-gray-900 text-green-400 border border-gray-700 rounded-lg font-mono text-sm focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green resize-none"
					></textarea>
				</div>
			</div>

			<div class="p-6 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-3">
				<button onclick={closeSpecModal} class="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 transition-colors">
					Cancel
				</button>
				<button
					onclick={saveSpec}
					disabled={specSaving}
					class="px-5 py-2 bg-reindeer-green text-white rounded-lg hover:bg-reindeer-green-dark transition-colors text-sm font-medium disabled:opacity-50"
				>
					{#if specSaving}
						Saving...
					{:else}
						{editingSpec ? 'Update' : 'Create'}
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Create Environment Modal -->
{#if showCreateEnvModal}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onclick={closeEnvModal}>
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="bg-white rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl" onclick={(e) => e.stopPropagation()}>
			<div class="p-6 border-b border-gray-200 bg-gray-50">
				<h2 class="text-lg font-semibold text-gray-900">New Environment</h2>
				<p class="text-gray-500 text-sm mt-1">Spin up a VM from a devcontainer spec</p>
			</div>

			<div class="p-6 space-y-4">
				{#if envError}
					<div class="bg-red-50 border border-red-200 rounded-lg p-3 text-red-700 text-sm">{envError}</div>
				{/if}

				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1" for="env-spec">Spec</label>
					<select
						id="env-spec"
						bind:value={selectedSpecId}
						class="w-full px-4 py-2.5 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green text-sm"
					>
						<option value="">Select a spec...</option>
						{#each specs as spec}
							<option value={spec.id}>{spec.name}</option>
						{/each}
					</select>
				</div>

				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1" for="env-name">Name <span class="text-gray-400 font-normal">(optional)</span></label>
					<input
						id="env-name"
						type="text"
						bind:value={envName}
						placeholder="Auto-generated from spec name"
						class="w-full px-4 py-2.5 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green text-sm"
					/>
				</div>

				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1" for="env-machine">Machine type <span class="text-gray-400 font-normal">(optional override)</span></label>
					<input
						id="env-machine"
						type="text"
						bind:value={machineTypeOverride}
						placeholder="e.g. e2-standard-8 (auto-detected from spec)"
						class="w-full px-4 py-2.5 bg-gray-50 border border-gray-300 rounded-lg text-gray-900 focus:outline-none focus:border-reindeer-green focus:ring-1 focus:ring-reindeer-green text-sm"
					/>
				</div>
			</div>

			<div class="p-6 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-3">
				<button onclick={closeEnvModal} class="px-4 py-2 text-sm text-gray-700 hover:text-gray-900 transition-colors">
					Cancel
				</button>
				<button
					onclick={createEnvironment}
					disabled={envCreating}
					class="px-5 py-2 bg-reindeer-green text-white rounded-lg hover:bg-reindeer-green-dark transition-colors text-sm font-medium disabled:opacity-50"
				>
					{#if envCreating}
						Creating...
					{:else}
						Create Environment
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Toast -->
{#if toastMessage}
	<div class="fixed bottom-6 right-6 bg-gray-900 text-white px-4 py-3 rounded-lg shadow-lg text-sm z-50 animate-fade-in">
		{toastMessage}
	</div>
{/if}

<style>
	@keyframes fade-in {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}
	:global(.animate-fade-in) {
		animation: fade-in 0.2s ease-out;
	}
</style>
