<script lang="ts">
  /**
   * THE FIELD THAT BRINGS UP AN ON-SCREEN KEYBOARD.
   *
   * The game screen is a canvas, and a canvas is not a text field: on a phone or tablet nothing
   * appears when the original asks for a password, a map code or the name of a save slot, because
   * the system keyboard is tied to a focused *editable element*, not to a key listener. So while an
   * entry runs, a real `<input>` holds the focus — invisible, one pixel wide, and never the text
   * itself: it only reports what was pressed, the buffer stays in the game state
   * ({@link editTextBuffer}).
   *
   * **The field is always in the document, not only while typing.** Focusing it has to happen inside
   * the tap that starts the entry — several mobile browsers open the keyboard only for a `focus()`
   * that a user gesture caused — and at that moment a conditionally rendered element would not
   * exist yet. Hence the callers focus it themselves ({@link focusEntry}) and `active` only decides
   * when to let go again.
   *
   * **Cancelling every edit is what keeps the value out of the way.** The field must not accumulate
   * text, because the game buffer is the only truth; and a cancelled `keydown` produces no
   * `beforeinput`, which is exactly what keeps a key from arriving twice on a hardware keyboard.
   */
  import { st } from '../shell/i18n.js';
  import { textKeyFromKeyDown, textKeysFromEdit } from './text-entry.js';

  let {
    active,
    digitsOnly = false,
    onkey,
  }: {
    /** Is an entry running? While it is not, the field must not hold the focus. */
    active: boolean;
    /** The map code takes digits only — that alone decides which keyboard a phone offers. */
    digitsOnly?: boolean;
    /** One key press, in the original's coding (`input_buffer_putchar` @0xd073). */
    onkey: (code: number) => void;
  } = $props();

  let el = $state<HTMLInputElement | null>(null);

  /**
   * Something to delete. Some on-screen keyboards report no backspace at all when the field is
   * empty, and the game buffer has places the field does not know about, so the field carries
   * filler and the caret sits at its end.
   */
  const FILLER = '        ';

  /** Take the focus — call this from the gesture that starts the entry, see the module comment. */
  export function focusEntry(): void {
    if (el === null) return;
    reset();
    el.focus({ preventScroll: true });
  }

  function reset(): void {
    if (el === null) return;
    el.value = FILLER;
    el.setSelectionRange(FILLER.length, FILLER.length);
  }

  $effect(() => {
    if (!active) el?.blur();
  });

  function handleKeyDown(e: KeyboardEvent): void {
    if (!active) return;
    const code = textKeyFromKeyDown(e);
    if (code === null) return;
    // `stopPropagation` because the view around this one listens for keys as well; without it a
    // key would be counted there a second time.
    e.preventDefault();
    e.stopPropagation();
    onkey(code);
  }

  function handleBeforeInput(e: InputEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!active) return;
    for (const code of textKeysFromEdit(e)) onkey(code);
  }

  function handleInput(): void {
    // Only reached when the edit could not be cancelled — a few on-screen keyboards report an
    // uncancelable composition. The key has already been taken in `handleBeforeInput`; what is left
    // to do is to put the field back the way it was.
    reset();
  }
</script>

<input
  bind:this={el}
  class="entry"
  type="text"
  value={FILLER}
  tabindex="-1"
  inputmode={digitsOnly ? 'numeric' : 'text'}
  enterkeyhint="done"
  autocomplete="off"
  autocapitalize="characters"
  spellcheck="false"
  aria-label={st('view.textEntry')}
  onkeydown={handleKeyDown}
  onbeforeinput={handleBeforeInput}
  oninput={handleInput}
/>

<style>
  /*
   * Invisible, but not `display: none` and not zero-sized: a field a browser considers hidden takes
   * no focus, and then no keyboard opens. `pointer-events: none` keeps it out of the way of taps on
   * the game screen — it is never aimed at, it is focused from code. The font size is the one thing
   * here that is not decoration: below 16 px iOS zooms the whole page towards a focused field.
   */
  .entry {
    position: absolute;
    left: 0;
    bottom: 0;
    width: 1px;
    height: 1px;
    padding: 0;
    border: 0;
    font-size: 16px;
    opacity: 0;
    pointer-events: none;
  }
</style>
