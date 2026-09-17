<script lang="ts">
  /**
   * The "leave out the rows that say nothing" switch of one group of the stock overview.
   *
   * One component rather than three copies, because the three tabs ask the SAME question about
   * three different things — only the wording differs, and that arrives as a key. What counts as
   * unused is decided where it can be tested, in `stock-overview.ts`.
   */
  import { st, type ShellKey } from '../shell/i18n.js';

  let {
    label,
    note,
    checked,
    onchange
  }: {
    label: ShellKey;
    /** A sentence of the group's own, put before the shared one. */
    note?: ShellKey;
    checked: boolean;
    onchange: (on: boolean) => void;
  } = $props();
</script>

<label class="switch">
  <input type="checkbox" {checked} onchange={(e) => onchange(e.currentTarget.checked)} />
  <span>{st(label)}</span>
</label>
<p class="note">
  {note === undefined ? '' : st(note) + ' '}{st('enh.stock.hideUnusedNote')}
</p>

<style>
  .switch {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .note {
    margin: 0;
    color: var(--fg-dim);
    line-height: 1.5;
  }
</style>
