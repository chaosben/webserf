<script lang="ts">
  /**
   * Which assistants get a plate over the game view — one line per entry in `assistants.ts`.
   *
   * Ticking a box switches nothing on: an assistant waits until it is asked, on its plate.
   */
  import { ASSISTANTS, assistantShown } from './assistants.js';
  import { settings } from '../settings/settings.svelte.js';
  import { st } from '../shell/i18n.js';
</script>

<section>
  <h3>{st('enh.assist.title')}</h3>
  <ul>
    {#each ASSISTANTS as assistant (assistant.id)}
      <li>
        <label>
          <input
            type="checkbox"
            checked={assistantShown(settings.value, assistant)}
            onchange={() => settings.set(assistant.showKey, !assistantShown(settings.value, assistant))}
          />
          <span>{st(assistant.labelKey)}</span>
        </label>
        <p class="note">{st(assistant.noteKey)}</p>
      </li>
    {/each}
  </ul>
  <p class="note">{st('enh.assist.note')}</p>
</section>

<style>
  section {
    display: grid;
    gap: 0.5rem;
  }

  h3 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  ul {
    display: grid;
    gap: 0.9rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .note {
    margin: 0.25rem 0 0;
    color: var(--fg-dim);
    line-height: 1.5;
  }

  ul + .note {
    padding-top: 0.9rem;
    border-top: 1px solid var(--line);
  }
</style>
