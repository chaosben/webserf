/**
 * Decoder for the sound effect entries of the archive (indices 3899..3988).
 *
 * Format (empirisch + Referenz-Implementierung):
 *   - Roh-PCM, **8-bit unsigned**, Mono.
 *   - sample rate **8000 Hz** (fixed, there is no header in the data).
 *   - no magic and no header — the TOC gives only `(size, offset)`, the entry is `size` sample
 *     bytes.
 *
 * Conversion for Web Audio (Float32 in `[-1, +1]`):
 *   `f = clamp((byte - 32) / 128, -1, +1)`
 *
 * **Bias correction**: the original samples are not centred unsigned PCM (mid 128),
 * sondern haben ihren effektiven Nullpunkt bei Byte ≈ 32. Ohne diese Korrektur startet
 * every sample block would carry a DC offset relative to silence -> a click at start and end.
 * Values > 160 (the upper sample edge) are clamped to +1, matching the int16 clipping of the
 * reference toolchain.
 */

/** Sample rate of every sound effect in the archive. */
export const SFX_SAMPLE_RATE = 8000;

export interface DecodedSound {
  /** Mono samples, normalised to `[-1, +1]`. */
  readonly samples: Float32Array;
  /** Sample rate in Hz (always 8000 for sound effects). */
  readonly sampleRate: number;
  /** Dauer in Sekunden. */
  readonly durationSec: number;
}

/**
 * Converts a raw sound entry into Float32 mono samples for Web Audio.
 *
 * @param raw   raw bytes from `PaArchive.getRaw(index)`.
 * @param sampleRate  Optional, default 8000 Hz.
 */
export function decodeSfx(raw: Uint8Array, sampleRate: number = SFX_SAMPLE_RATE): DecodedSound {
  const n = raw.byteLength;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (raw[i]! - 32) / 128;
    samples[i] = v > 1 ? 1 : v;
  }
  return {
    samples,
    sampleRate,
    durationSec: n / sampleRate,
  };
}
