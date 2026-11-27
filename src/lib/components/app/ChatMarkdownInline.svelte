<!-- Inline pieces of a chat answer (see chatMarkdown.ts). Model output only ever lands in text nodes. -->
<script lang="ts">
  import type { MarkdownInline } from '$lib/utils/chatMarkdown';

  export let nodes: MarkdownInline[];
</script>

{#each nodes as node}{#if node.type === 'text'}{node.text}{:else if node.type === 'code'}<code
      >{node.text}</code
    >{:else if node.type === 'strong'}<strong><svelte:self nodes={node.children} /></strong
    >{:else}<em><svelte:self nodes={node.children} /></em>{/if}{/each}
