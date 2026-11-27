<!--
  Renders a chat answer's markdown (headings, bold, lists, ...) as elements. The text is parsed
  into a tree by chatMarkdown.ts and drawn with ordinary Svelte markup, never {@html}, so model
  output cannot inject HTML. Re-parsed as the answer streams in.
-->
<script lang="ts">
  import { parseMarkdown } from '$lib/utils/chatMarkdown';
  import ChatMarkdownInline from '$lib/components/app/ChatMarkdownInline.svelte';

  export let text: string;

  $: blocks = parseMarkdown(text);
</script>

<div class="chat-markdown">
  {#each blocks as block}
    {#if block.type === 'heading'}
      <!-- Not h1-h6: the answer sits inside a page that has its own heading outline -->
      <div
        class="md-heading"
        class:md-heading-major={block.level <= 2}
        role="heading"
        aria-level={Math.min(6, block.level + 2)}
      >
        <ChatMarkdownInline nodes={block.children} />
      </div>
    {:else if block.type === 'paragraph'}
      <p><ChatMarkdownInline nodes={block.children} /></p>
    {:else if block.type === 'list'}
      <svelte:element
        this={block.ordered ? 'ol' : 'ul'}
        start={block.ordered ? block.start : undefined}
      >
        {#each block.items as item}
          <li style:margin-left="{item.depth * 1.25}rem">
            <ChatMarkdownInline nodes={item.children} />
          </li>
        {/each}
      </svelte:element>
    {:else if block.type === 'quote'}
      <blockquote><ChatMarkdownInline nodes={block.children} /></blockquote>
    {:else if block.type === 'code'}
      <pre><code>{block.text}</code></pre>
    {:else}
      <hr />
    {/if}
  {/each}
</div>

<style>
  .chat-markdown > :global(:last-child) {
    margin-bottom: 0;
  }
  /* Single line breaks inside a paragraph, list item or quote are kept as written */
  p,
  li,
  blockquote {
    white-space: pre-line;
  }
  p,
  ul,
  ol,
  blockquote,
  pre {
    margin-bottom: 0.5rem;
  }
  ul,
  ol {
    padding-left: 1.25rem;
  }
  .md-heading {
    font-weight: 600;
    margin: 0.75rem 0 0.25rem;
  }
  .md-heading:first-child {
    margin-top: 0;
  }
  .md-heading-major {
    font-size: 1.1em;
  }
  blockquote {
    border-left: 3px solid var(--bs-border-color, #dee2e6);
    padding-left: 0.75rem;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  hr {
    margin: 0.5rem 0;
  }
</style>
