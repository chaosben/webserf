<script lang="ts">
  /** Looks the open tab of the open enhancement up and renders its body — see `registry.ts`. */
  import { enhancementTabFor, type Enhancement } from './registry.js';

  let { enhancement, tab }: { enhancement: Enhancement; tab: string | null } = $props();

  const Body = $derived(enhancementTabFor(enhancement, tab).panel);
</script>

<Body />
