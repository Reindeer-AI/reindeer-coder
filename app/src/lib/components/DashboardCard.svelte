<script lang="ts">
interface Props {
	title: string;
	value: string | number;
	subtitle?: string;
	icon?: string;
	color?: 'green' | 'blue' | 'yellow' | 'red' | 'gray';
}

let { title, value, subtitle, icon, color = 'green' }: Props = $props();
</script>

<div class="bg-white rounded-xl border border-gray-200 p-6">
	<div class="flex items-start justify-between mb-3">
		<h3 class="text-sm font-medium text-gray-500">{title}</h3>
		{#if icon}
			<span class="text-2xl">{icon}</span>
		{/if}
	</div>

	<div class="mb-2">
		<p class="text-3xl font-bold text-gray-900">{value}</p>
	</div>

	{#if subtitle}
		<p class="text-sm text-gray-500">{subtitle}</p>
	{/if}
</div>
