<script lang="ts">
  import WAHSChat from '$lib/components/app/WAHSChat.svelte';
  import { INSTANCE_CONFIG } from '$lib/config/instance_config';
</script>

<svelte:head>
  <title>Ask WAHS - {INSTANCE_CONFIG.title}</title>
</svelte:head>

<WAHSChat />
