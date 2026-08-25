<script lang="ts">
  /**
   * The end credits as a screen — the interaction side of `core/end-credits.ts`
   * (`run_end_credits` @0x38b55).
   *
   * Own 352 × 240 surface and **no** chrome: the original always runs in the small set
   * (@0x38845/@0x3884f bracket it in `toggle_screen_layout`) and paints over everything with
   * `fill_rect(0, 0, 0x160, 0xf0)`; frame and control bar come back only afterwards.
   *
   * **No click handler**: the credits cannot be aborted (call census) — a "skip" would be an
   * invention.
   */
  import {
    END_CREDITS_MUSIC_AFTER,
    END_CREDITS_MUSIC_ENTRY,
    END_CREDITS_MUSIC_VOLUME,
    END_CREDITS_PALETTE_ENTRY,
    advanceEndCredits,
    drawEndCredits,
    endCreditsFrame,
    initialEndCreditsState,
    type EndCreditsState,
  } from '../core/end-credits.js';
  import { MENU_SURFACE, type MenuTarget } from '../core/main-menu.js';
  import {
    GLYPH_ENTRY,
    blitSprite,
    clearFramebuffer,
    createFramebuffer,
    fillRect,
  } from '../core/ui-render.js';
  import { parseInArchivePalette } from '../core/pal-parser.js';
  import { decodeSprite } from '../core/sprite-decoder.js';
  import type { MusicPlayer } from './music-player.js';
  import type { PaArchive } from '../core/pa-parser.js';
  import type { DecodedSprite, Palette } from '../core/types.js';
  import { st } from '../shell/i18n.js';
  import { fitScale } from './zoom-gesture.js';

  let {
    archive,
    onfinished,
    music = null,
    volume = 0,
  }: {
    archive: PaArchive;
    /** Runs when the sequence is through. */
    onfinished: () => void;
    /**
     * The caller's player — the credits switch the title and put it back afterwards, exactly as
     * `run_end_credits` does inline. `null` = no archive/synth, then it stays silent.
     */
    music?: MusicPlayer | null;
    /** The user volume (0..99) the credits restore at the end (`gs+0x3dc` @0x38f90). */
    volume?: number;
  } = $props();

  /** 100 Hz is an assumption (as in the opening credits); proven is only the ticks per frame. */
  const TICK_MS = 10;

  let canvas: HTMLCanvasElement | null = $state(null);
  let seq: EndCreditsState = $state(initialEndCreditsState());

  /**
   * **The aspect ratio the 352 × 240 are stretched into.** It is the area of the DOS video mode on
   * a 4:3 screen, i.e. pixel aspect 0.909. Square pixels (as in the main menu) would be the
   * alternative; the stretched case is the deliberate choice here, because the sequence is a full
   * picture and not a screen whose pixels are checked against a capture.
   */
  const DISPLAY_ASPECT = { width: 640, height: 480 } as const;

  let availWidth = $state(0);
  let availHeight = $state(0);

  /**
   * The largest rectangle of ratio {@link DISPLAY_ASPECT} that fits the stage — the same fitting
   * the main menu does with {@link fitScale}.
   *
   * Why that is needed: the credits used to sit in a box of **640 × 480 CSS pixels** (`UI_SCREEN`
   * times `uiScale`, and `uiScale` is exactly 1 at every zoom <= 1). In a larger window that was a
   * small box at the bottom centre with the stage colour around it as a black frame — the
   * reported fault. The original paints over the **whole** screen, so the sequence takes the
   * whole stage here too.
   */
  const fitted = $derived.by<{ w: number; h: number } | null>(() => {
    if (availWidth <= 0 || availHeight <= 0) return null;
    const s = fitScale(
      Number.POSITIVE_INFINITY,
      { width: availWidth, height: availHeight },
      DISPLAY_ASPECT,
    );
    return { w: Math.round(DISPLAY_ASPECT.width * s), h: Math.round(DISPLAY_ASPECT.height * s) };
  });

  /**
   * The credits bring their own palette (@0x38bc6). Restoring it like the original (@0x38f62) is
   * moot here: the surface disappears with the screen.
   */
  const assets = $derived.by<{ provider: (e: number) => DecodedSprite | null; palette: Palette } | null>(
    () => {
      const raw = archive.getRaw(END_CREDITS_PALETTE_ENTRY);
      if (raw === null) return null;
      let pal: Palette;
      try {
        pal = parseInArchivePalette(raw);
      } catch {
        return null;
      }
      const cache = new Map<number, DecodedSprite | null>();
      const provider = (entry: number): DecodedSprite | null => {
        const cached = cache.get(entry);
        if (cached !== undefined) return cached;
        let sprite: DecodedSprite | null = null;
        try {
          const data = archive.getRaw(entry);
          if (data !== null) sprite = decodeSprite(data, pal, { physicalIndex: entry });
        } catch {
          // Empty or unreadable slot — pass over it silently.
        }
        cache.set(entry, sprite);
        return sprite;
      };
      return { provider, palette: pal };
    },
  );

  /**
   * **The end-credits music** (@0x38b55..@0x38b8a and @0x38f67..@0x38f9d).
   *
   * The original does both inline in the credits, in this order: stop music (`call 0xbe7f`
   * @0x38b62), two driver primitives, start title `0xf98` (@0x38b7b) and set the volume to **100**
   * (@0x38b8a) — {@link END_CREDITS_MUSIC_VOLUME}. At the end the same chain back to `0xf96` with
   * the user volume `gs+0x3dc`.
   *
   * Restoring happens here in the **cleanup return** and not in the `onfinished` path: our surface
   * can disappear before the sequence is through (`showEndCredits` hangs on a `$derived` of the
   * caller), the original cannot. That way the game title comes back in **every** case. `volume` is
   * read only on cleanup and is therefore not a dependency — otherwise every move of the slider
   * would briefly switch the title back.
   *
   * Nothing is gated: whether music plays at all is the caller's decision (`musicShouldPlay`), and
   * a title change on a silent player has no effect — in the original that is the driver test
   * `gs[0x1f5]` @0x38b5e, which skips both blocks.
   */
  $effect(() => {
    const player = music;
    if (player === null) return;
    void player.setTrack(END_CREDITS_MUSIC_ENTRY);
    player.setVolume(END_CREDITS_MUSIC_VOLUME);
    return () => {
      void player.setTrack(END_CREDITS_MUSIC_AFTER);
      player.setVolume(volume);
    };
  });

  /**
   * Fade-out ramp of the closing phase: `frame.volume` is the counter `0x1c(%edi)` and falls from
   * 99 towards 0 over the last 100 frames (@0x38ef2/@0x38f03).
   */
  $effect(() => {
    const player = music;
    const v = endCreditsFrame(seq.frame).volume;
    if (player !== null && v !== null) player.setVolume(v);
  });

  $effect(() => {
    let last = performance.now();
    let raf = 0;
    const step = (now: number): void => {
      const ticks = Math.floor((now - last) / TICK_MS);
      if (ticks > 0) {
        last += ticks * TICK_MS;
        const next = advanceEndCredits(seq, ticks);
        seq = next;
        if (next.done) {
          onfinished();
          return;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  });

  $effect(() => {
    const el = canvas;
    const a = assets;
    const frame = endCreditsFrame(seq.frame);
    if (el === null || a === null) return;
    const ctx = el.getContext('2d');
    if (ctx === null) return;
    const { provider: draw, palette: pal } = a;
    const rgb = (color: number): [number, number, number] => [
      pal.rgba[color * 4] ?? 0,
      pal.rgba[color * 4 + 1] ?? 0,
      pal.rgba[color * 4 + 2] ?? 0,
    ];
    // Natively onto a 352×240 framebuffer; the display size is CSS's job.
    const fb = createFramebuffer(MENU_SURFACE.width, MENU_SURFACE.height);
    clearFramebuffer(fb, 0, 0, 0);
    const target: MenuTarget = {
      icon(entry, x, y) {
        const sprite = draw(entry);
        if (sprite !== null) blitSprite(fb, sprite, x, y);
      },
      glyph(entry, x, y, color) {
        const sprite = draw(entry);
        if (sprite !== null) blitSprite(fb, sprite, x, y, rgb(color));
      },
      fill(x, y, w, h, color) {
        fillRect(fb, x, y, w, h, rgb(color));
      },
    };
    drawEndCredits(target, frame, (ch) => GLYPH_ENTRY.get(ch));
    const img = ctx.createImageData(fb.width, fb.height);
    img.data.set(fb.rgba);
    ctx.putImageData(img, 0, 0);
  });
</script>

<div class="end-credits-stage" bind:clientWidth={availWidth} bind:clientHeight={availHeight}>
  <canvas
    bind:this={canvas}
    width={MENU_SURFACE.width}
    height={MENU_SURFACE.height}
    class="end-credits"
    style:width={fitted === null ? null : `${fitted.w}px`}
    style:height={fitted === null ? null : `${fitted.h}px`}
    aria-label={st('view.endCredits')}
  ></canvas>
</div>

<style>
  /* The stage is black because the original paints the whole surface with colour 0 — on a
     window that is not 4:3, exactly this colour stays at the sides (or top and bottom). */
  .end-credits-stage {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: #000;
  }
  /* A class rather than plain `canvas`: the caller puts the surface into a box whose own `canvas`
     rule would have the same specificity — with a class this one wins reliably. */
  canvas.end-credits {
    display: block;
    image-rendering: pixelated;
    background: #000;
    /* Only for the first picture, before the measurement — afterwards `fitted` sets the size. */
    max-width: 100%;
    max-height: 100%;
  }
</style>
