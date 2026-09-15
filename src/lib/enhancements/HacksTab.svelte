<script lang="ts">
  /**
   * Which hacks get a switch in the overlay — one line per entry in `hacks.ts`, so a new hack needs
   * no code here.
   *
   * This tab does not switch anything on. Ticking a box puts the hack's switch over the game view,
   * and that is where it is flipped; see `hacks.ts` for why the two are separate.
   */
  import { HACKS, hackShown } from './hacks.js';
  import { PICKER_ICON_SCALE, mapObjectImage } from './icon-images.svelte.js';
  import { settings } from '../settings/settings.svelte.js';
  import { st } from '../shell/i18n.js';
</script>

<section>
  <h3>{st('enh.hacks.title')}</h3>
  <ul>
    {#each HACKS as hack (hack.id)}
      <li>
        <label>
          <input
            type="checkbox"
            checked={hackShown(settings.value, hack)}
            onchange={() => settings.set(hack.showKey, !hackShown(settings.value, hack))}
          />
          <span>{st(hack.labelKey)}</span>
          <!-- The same pictures the switch carries, so the line here and the switch out there are
               recognisably the same thing. The NAME stays: a dialog of nameless pictures cannot be
               aimed at, and there may be no archive. -->
          {#each hack.objects ?? [] as object (object)}
            {@const pic = mapObjectImage(object, PICKER_ICON_SCALE)}
            {#if pic !== null}
              <img src={pic.url} alt="" width={pic.width} height={pic.height} />
            {/if}
          {/each}
        </label>
        <p class="note">{st(hack.noteKey)}</p>
      </li>
    {/each}
  </ul>
  <p class="note">{st('enh.hacks.note')}</p>
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

  /* No width: the picture is rendered at its step and already stands on whole pixels. */
  img {
    image-rendering: pixelated;
  }

  .note {
    margin: 0.25rem 0 0;
    color: var(--fg-dim);
    line-height: 1.5;
  }

  /* The closing sentence stands apart from the list, not under the last hack's own note. */
  ul + .note {
    padding-top: 0.9rem;
    border-top: 1px solid var(--line);
  }
</style>
