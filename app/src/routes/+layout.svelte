<script lang="ts">
import '../app.css';

let { children } = $props();
</script>

<svelte:head>
	<title>Vibe Coding</title>
</svelte:head>

{@render children()}
