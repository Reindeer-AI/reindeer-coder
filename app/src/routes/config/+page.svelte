<script lang="ts">
import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { authToken, isAuthenticated } from '$lib/stores/auth';

interface Config {
	key: string;
	value: string;
	description: string | null;
	is_secret: boolean;
	category: string | null;
	created_at: string;
	updated_at: string;
}

interface Repository {
	id: string;
	name: string;
	url: string;
	baseBranch: string;
	allowManual: boolean;
}

let configs: Config[] = [];
let loading = true;
let error = '';
let saving = false;

// Edit state
let editingKey: string | null = null;
let editValue = '';
let editDescription = '';
let editIsSecret = false;
let editCategory = '';

// New config state
let showNewConfigModal = false;
let newKey = '';
let newValue = '';
let newDescription = '';
let newIsSecret = false;
let newCategory = '';

// Repository management state
let showRepoModal = false;
let repositories: Repository[] = [];
let editingRepoIndex: number | null = null;
let repoForm = {
	id: '',
	name: '',
	url: '',
	baseBranch: 'main',
	allowManual: true,
};

// Group configs by category
$: configsByCategory = configs.reduce(
	(acc, config) => {
		const cat = config.category || 'Uncategorized';
		if (!acc[cat]) acc[cat] = [];
		acc[cat].push(config);
		return acc;
	},
	{} as Record<string, Config[]>
);

onMount(async () => {
	if (!$isAuthenticated) {
		goto('/');
		return;
	}
	await loadConfigs();
	await loadRepositories();
});

async function loadConfigs() {
	loading = true;
	error = '';
	try {
		const token = $authToken;
		if (!token) {
			error = 'Not authenticated';
			return;
		}

		const res = await fetch('/api/config', {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});
		if (!res.ok) {
			if (res.status === 403) {
				error = 'Access denied. Admin permission required.';
			} else {
				throw new Error('Failed to load configuration');
			}
			return;
		}
		const data = await res.json();
		configs = data.configs;
	} catch (err: any) {
		error = err.message || 'Failed to load configuration';
		console.error(err);
	} finally {
		loading = false;
	}
}

function startEdit(config: Config) {
	editingKey = config.key;
	editValue = config.is_secret ? '' : config.value; // Don't show secret values
	editDescription = config.description || '';
	editIsSecret = config.is_secret;
	editCategory = config.category || '';
}

function cancelEdit() {
	editingKey = null;
	editValue = '';
	editDescription = '';
	editIsSecret = false;
	editCategory = '';
}

async function saveEdit(key: string) {
	saving = true;
	try {
		const token = $authToken;
		if (!token) {
			error = 'Not authenticated';
			return;
		}

		// If editing a secret and value is empty, don't update it
		const isSecretAndEmpty = editIsSecret && editValue.trim() === '';

		const res = await fetch('/api/config', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				key,
				value: isSecretAndEmpty ? '[UNCHANGED]' : editValue,
				description: editDescription || null,
				is_secret: editIsSecret,
				category: editCategory || null,
			}),
		});

		if (!res.ok) throw new Error('Failed to save configuration');

		await loadConfigs();
		cancelEdit();
	} catch (err: any) {
		error = err.message || 'Failed to save configuration';
		console.error(err);
	} finally {
		saving = false;
	}
}

async function deleteConfig(key: string) {
	if (!confirm(`Are you sure you want to delete "${key}"?`)) return;

	try {
		const token = $authToken;
		if (!token) {
			error = 'Not authenticated';
			return;
		}

		const res = await fetch(`/api/config/${encodeURIComponent(key)}`, {
			method: 'DELETE',
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		if (!res.ok) throw new Error('Failed to delete configuration');

		await loadConfigs();
	} catch (err: any) {
		error = err.message || 'Failed to delete configuration';
		console.error(err);
	}
}

async function loadRepositories() {
	try {
		const token = $authToken;
		if (!token) return;

		const res = await fetch('/api/config/repositories.list', {
			headers: { Authorization: `Bearer ${token}` },
		});

		if (res.ok) {
			const data = await res.json();
			try {
				repositories = JSON.parse(data.config.value);
			} catch {
				repositories = [];
			}
		} else {
			repositories = [];
		}
	} catch (err) {
		console.error('Failed to load repositories:', err);
		repositories = [];
	}
}

function openRepoModal(index: number | null = null) {
	if (index !== null) {
		editingRepoIndex = index;
		const repo = repositories[index];
		repoForm = { ...repo };
	} else {
		editingRepoIndex = null;
		repoForm = {
			id: '',
			name: '',
			url: '',
			baseBranch: 'main',
			allowManual: true,
		};
	}
	showRepoModal = true;
}

async function saveRepository() {
	saving = true;
	try {
		const token = $authToken;
		if (!token) {
			error = 'Not authenticated';
			return;
		}

		if (!repoForm.id || !repoForm.name || !repoForm.url) {
			error = 'ID, name, and URL are required';
			return;
		}

		let updatedRepos = [...repositories];
		if (editingRepoIndex !== null) {
			updatedRepos[editingRepoIndex] = { ...repoForm };
		} else {
			// Check for duplicate ID
			if (updatedRepos.some((r) => r.id === repoForm.id)) {
				error = 'Repository ID already exists';
				return;
			}
			updatedRepos.push({ ...repoForm });
		}

		const res = await fetch('/api/config', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				key: 'repositories.list',
				value: JSON.stringify(updatedRepos),
				description: 'List of pre-configured repositories',
				is_secret: false,
				category: 'Repositories',
			}),
		});

		if (!res.ok) throw new Error('Failed to save repository');

		await loadRepositories();
		await loadConfigs();
		showRepoModal = false;
		error = '';
	} catch (err: any) {
		error = err.message || 'Failed to save repository';
	} finally {
		saving = false;
	}
}

async function deleteRepository(index: number) {
	if (!confirm(`Delete repository "${repositories[index].name}"?`)) return;

	saving = true;
	try {
		const token = $authToken;
		if (!token) {
			error = 'Not authenticated';
			return;
		}

		const updatedRepos = repositories.filter((_, i) => i !== index);

		const res = await fetch('/api/config', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				key: 'repositories.list',
				value: JSON.stringify(updatedRepos),
				description: 'List of pre-configured repositories',
				is_secret: false,
				category: 'Repositories',
			}),
		});

		if (!res.ok) throw new Error('Failed to delete repository');

		await loadRepositories();
		await loadConfigs();
	} catch (err: any) {
		error = err.message || 'Failed to delete repository';
	} finally {
		saving = false;
	}
}

async function saveNewConfig() {
	saving = true;
	try {
		if (!newKey.trim() || !newValue.trim()) {
			error = 'Key and value are required';
			return;
		}

		const token = $authToken;
		if (!token) {
			error = 'Not authenticated';
			return;
		}

		const res = await fetch('/api/config', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				key: newKey.trim(),
				value: newValue,
				description: newDescription || null,
				is_secret: newIsSecret,
				category: newCategory || null,
			}),
		});

		if (!res.ok) {
			const data = await res.json();
			throw new Error(data.message || 'Failed to create configuration');
		}

		await loadConfigs();
		showNewConfigModal = false;
		newKey = '';
		newValue = '';
		newDescription = '';
		newIsSecret = false;
		newCategory = '';
	} catch (err: any) {
		error = err.message || 'Failed to create configuration';
		console.error(err);
	} finally {
		saving = false;
	}
}
</script>

<div class="min-h-screen bg-gray-50">
	<!-- Header -->
	<header class="bg-white border-b border-gray-200 px-6 py-4">
		<div class="max-w-7xl mx-auto flex items-center justify-between">
			<div class="flex items-center gap-4">
				<a href="/" class="text-blue-600 hover:text-blue-700">
					← Back to Home
				</a>
				<h1 class="text-xl font-semibold text-gray-900">Configuration Management</h1>
			</div>
			<button
				onclick={() => (showNewConfigModal = true)}
				class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
			>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd" />
				</svg>
				Add Configuration
			</button>
		</div>
	</header>

	<!-- Content -->
	<div class="max-w-7xl mx-auto px-6 py-8">
		{#if error}
			<div class="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
				<p class="text-red-700">{error}</p>
			</div>
		{/if}

		<!-- Repositories Section -->
		<div class="bg-white rounded-lg border border-gray-200 overflow-hidden mb-6">
			<div class="bg-gray-50 px-6 py-3 border-b border-gray-200 flex items-center justify-between">
				<h2 class="text-lg font-semibold text-gray-900">Repositories</h2>
				<button
					onclick={() => openRepoModal(null)}
					class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded transition-colors"
				>
					+ Add Repository
				</button>
			</div>
			<div class="divide-y divide-gray-200">
				{#each repositories as repo, index}
					<div class="p-4 hover:bg-gray-50">
						<div class="flex items-start justify-between">
							<div class="flex-1">
								<div class="flex items-center gap-2 mb-1">
									<h3 class="text-sm font-semibold text-gray-900">{repo.name}</h3>
									<span class="px-2 py-0.5 text-xs font-mono bg-gray-100 text-gray-700 rounded">
										{repo.id}
									</span>
									{#if !repo.allowManual}
										<span class="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-800 rounded">
											Linear only
										</span>
									{/if}
								</div>
								<p class="text-sm text-gray-600 font-mono">{repo.url}</p>
								<p class="text-xs text-gray-500 mt-1">
									Base branch: <span class="font-mono">{repo.baseBranch}</span>
								</p>
							</div>
							<div class="flex gap-2 ml-4">
								<button
									onclick={() => openRepoModal(index)}
									class="px-3 py-1 text-sm text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors"
								>
									Edit
								</button>
								<button
									onclick={() => deleteRepository(index)}
									class="px-3 py-1 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded transition-colors"
								>
									Delete
								</button>
							</div>
						</div>
					</div>
				{/each}
				{#if repositories.length === 0}
					<div class="p-8 text-center text-gray-500">
						<p class="mb-2">No repositories configured.</p>
						<button
							onclick={() => openRepoModal(null)}
							class="text-blue-600 hover:text-blue-700 font-medium"
						>
							Add your first repository →
						</button>
					</div>
				{/if}
			</div>
		</div>

		{#if loading}
			<div class="flex items-center justify-center h-64">
				<div class="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-600"></div>
			</div>
		{:else}
			<div class="space-y-6">
				{#each Object.entries(configsByCategory) as [category, categoryConfigs]}
					<div class="bg-white rounded-lg border border-gray-200 overflow-hidden">
						<div class="bg-gray-50 px-6 py-3 border-b border-gray-200">
							<h2 class="text-lg font-semibold text-gray-900">{category}</h2>
						</div>
						<div class="divide-y divide-gray-200">
							{#each categoryConfigs as config}
								<div class="p-6">
									{#if editingKey === config.key}
										<!-- Edit mode -->
										<div class="space-y-4">
											<div>
												<label class="block text-sm font-medium text-gray-700 mb-1">
													Key
												</label>
												<input
													type="text"
													value={config.key}
													disabled
													class="w-full px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-500 cursor-not-allowed"
												/>
											</div>
											<div>
												<label class="block text-sm font-medium text-gray-700 mb-1">
													Value {config.is_secret ? '(Leave empty to keep unchanged)' : ''}
												</label>
												{#if config.is_secret}
													<input
														type="password"
														bind:value={editValue}
														placeholder="Enter new value (or leave empty)"
														class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
													/>
												{:else}
													<textarea
														bind:value={editValue}
														rows="3"
														class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
													></textarea>
												{/if}
											</div>
											<div>
												<label class="block text-sm font-medium text-gray-700 mb-1">
													Description
												</label>
												<input
													type="text"
													bind:value={editDescription}
													placeholder="Optional description"
													class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
												/>
											</div>
											<div>
												<label class="block text-sm font-medium text-gray-700 mb-1">
													Category
												</label>
												<input
													type="text"
													bind:value={editCategory}
													placeholder="Optional category"
													class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
												/>
											</div>
											<div class="flex items-center gap-2">
												<input
													type="checkbox"
													id={`secret-${config.key}`}
													bind:checked={editIsSecret}
													class="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
												/>
												<label for={`secret-${config.key}`} class="text-sm text-gray-700">
													Is Secret (value will be hidden)
												</label>
											</div>
											<div class="flex gap-2">
												<button
													onclick={() => saveEdit(config.key)}
													disabled={saving}
													class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50"
												>
													{saving ? 'Saving...' : 'Save'}
												</button>
												<button
													onclick={cancelEdit}
													disabled={saving}
													class="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg disabled:opacity-50"
												>
													Cancel
												</button>
											</div>
										</div>
									{:else}
										<!-- View mode -->
										<div class="flex items-start justify-between">
											<div class="flex-1">
												<div class="flex items-center gap-2 mb-1">
													<h3 class="text-sm font-mono text-gray-900">{config.key}</h3>
													{#if config.is_secret}
														<span class="px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 rounded">
															Secret
														</span>
													{/if}
												</div>
												{#if config.description}
													<p class="text-sm text-gray-600 mb-2">{config.description}</p>
												{/if}
												<div class="text-sm text-gray-700 font-mono bg-gray-50 px-3 py-2 rounded border border-gray-200">
													{config.value}
												</div>
												<p class="text-xs text-gray-500 mt-2">
													Updated: {new Date(config.updated_at).toLocaleString()}
												</p>
											</div>
											<div class="flex gap-2 ml-4">
												<button
													onclick={() => startEdit(config)}
													class="px-3 py-1 text-sm text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors"
												>
													Edit
												</button>
												<button
													onclick={() => deleteConfig(config.key)}
													class="px-3 py-1 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded transition-colors"
												>
													Delete
												</button>
											</div>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</div>
				{/each}

				{#if Object.keys(configsByCategory).length === 0}
					<div class="text-center py-12">
						<p class="text-gray-500 mb-4">No configuration values found.</p>
						<button
							onclick={() => (showNewConfigModal = true)}
							class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
						>
							Add Your First Configuration
						</button>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

<!-- Repository Modal -->
{#if showRepoModal}
	<div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
		<div class="bg-white rounded-lg shadow-xl max-w-2xl w-full">
			<div class="p-6 border-b border-gray-200">
				<h2 class="text-xl font-semibold text-gray-900">
					{editingRepoIndex !== null ? 'Edit Repository' : 'Add Repository'}
				</h2>
			</div>
			<div class="p-6 space-y-4">
				{#if error}
					<div class="bg-red-50 border border-red-200 rounded-lg p-3">
						<p class="text-sm text-red-700">{error}</p>
					</div>
				{/if}
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1">
						ID * <span class="text-xs text-gray-500">(unique identifier, lowercase, no spaces)</span>
					</label>
					<input
						type="text"
						bind:value={repoForm.id}
						disabled={editingRepoIndex !== null}
						placeholder="e.g., experimental, workflows"
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent {editingRepoIndex !== null ? 'bg-gray-100' : ''}"
					/>
				</div>
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1">
						Display Name *
					</label>
					<input
						type="text"
						bind:value={repoForm.name}
						placeholder="e.g., reindeerai/experimental"
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					/>
				</div>
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1">
						Repository URL *
					</label>
					<input
						type="text"
						bind:value={repoForm.url}
						placeholder="https://gitlab.com/org/repo.git"
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					/>
				</div>
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1">
						Base Branch *
					</label>
					<input
						type="text"
						bind:value={repoForm.baseBranch}
						placeholder="main"
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					/>
				</div>
				<div class="flex items-center gap-2">
					<input
						type="checkbox"
						id="repo-allow-manual"
						bind:checked={repoForm.allowManual}
						class="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
					/>
					<label for="repo-allow-manual" class="text-sm text-gray-700">
						Allow manual task descriptions (uncheck for Linear-only)
					</label>
				</div>
			</div>
			<div class="p-6 border-t border-gray-200 flex gap-2 justify-end">
				<button
					onclick={() => {
						showRepoModal = false;
						error = '';
					}}
					disabled={saving}
					class="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					onclick={saveRepository}
					disabled={saving}
					class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50"
				>
					{saving ? 'Saving...' : editingRepoIndex !== null ? 'Update' : 'Add'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- New Config Modal -->
{#if showNewConfigModal}
	<div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
		<div class="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
			<div class="p-6 border-b border-gray-200">
				<h2 class="text-xl font-semibold text-gray-900">Add Configuration</h2>
			</div>
			<div class="p-6 space-y-4">
				{#if error}
					<div class="bg-red-50 border border-red-200 rounded-lg p-3">
						<p class="text-sm text-red-700">{error}</p>
					</div>
				{/if}
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1">
						Key *
					</label>
					<input
						type="text"
						bind:value={newKey}
						placeholder="e.g., ui.brand_name or git.default_branch"
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					/>
					<p class="text-xs text-gray-500 mt-1">Use dot notation for organization (e.g., category.subcategory.name)</p>
				</div>
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1">
						Value *
					</label>
					{#if newIsSecret}
						<input
							type="password"
							bind:value={newValue}
							placeholder="Enter secret value"
							class="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
						/>
					{:else}
						<textarea
							bind:value={newValue}
							rows="3"
							placeholder="Enter configuration value"
							class="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
						></textarea>
					{/if}
				</div>
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1">
						Description
					</label>
					<input
						type="text"
						bind:value={newDescription}
						placeholder="Optional description of this configuration"
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					/>
				</div>
				<div>
					<label class="block text-sm font-medium text-gray-700 mb-1">
						Category
					</label>
					<input
						type="text"
						bind:value={newCategory}
						placeholder="e.g., UI, Git, VM, Agent"
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					/>
				</div>
				<div class="flex items-center gap-2">
					<input
						type="checkbox"
						id="new-is-secret"
						bind:checked={newIsSecret}
						class="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
					/>
					<label for="new-is-secret" class="text-sm text-gray-700">
						Is Secret (value will be hidden after saving)
					</label>
				</div>
			</div>
			<div class="p-6 border-t border-gray-200 flex gap-2 justify-end">
				<button
					onclick={() => {
						showNewConfigModal = false;
						error = '';
					}}
					disabled={saving}
					class="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					onclick={saveNewConfig}
					disabled={saving}
					class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-50"
				>
					{saving ? 'Creating...' : 'Create'}
				</button>
			</div>
		</div>
	</div>
{/if}
