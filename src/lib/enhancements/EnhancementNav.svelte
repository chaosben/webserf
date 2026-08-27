<script lang="ts">
  /**
   * The column on the left of the enhancements panel: one button per enhancement.
   *
   * Deliberately not a second tab strip — the strip on the right belongs to the open enhancement,
   * and two `role="tablist"` next to each other would leave a screen reader guessing which of them
   * the body belongs to. This is a plain list; `aria-current` says which entry is open.
   */
  import { st } from '../shell/i18n.js';
  import type { Enhancement } from './registry.js';

  let {
    enhancements,
    active,
    onselect
  }: {
    enhancements: readonly Enhancement[];
    active: string;
    onselect: (id: string) => void;
  } = $props();
</script>

<ul>
  {#each enhancements as enh (enh.id)}
    <li>
      <button
        type="button"
        class:active={enh.id === active}
        aria-current={enh.id === active ? 'true' : undefined}
        onclick={() => onselect(enh.id)}
      >
        {st(enh.labelKey)}
      </button>
    </li>
  {/each}
</ul>

<style>
  ul {
    margin: 0;
    padding: 0.4rem 0;
    list-style: none;
    display: grid;
    gap: 1px;
  }

  button {
    display: block;
    width: 100%;
    border: none;
    border-left: 2px solid transparent;
    background: none;
    padding: 0.35rem 0.8rem;
    color: var(--fg-dim);
    text-align: left;
    white-space: nowrap;
  }

  button:hover {
    color: var(--accent);
  }

  button.active {
    color: var(--amber);
    border-left-color: var(--amber);
  }
</style>
