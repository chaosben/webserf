/**
 * Background music - the byte-verified facts, without the browser part. The player itself lives in
 * `lib/music-player.ts`; here stands only which track plays and when.
 *
 * There is ONE track for the whole game. The driver primitive "play track" has exactly three call
 * sites in the binary: the game music at start-up, the end credits track, and the game music again
 * afterwards. So there is no track change during play - no piece per map, no combat music, no
 * playlist. The indices are DOS indices (1-based like the asset registry); our parser counts from 0.
 *
 * The volume is the SAME as for the sound effects (`gs+0x3dc`) - the original has no separate music
 * slider.
 *
 * Two bits gate playback: `gs+0x1cb` bit 1 is the user option, bit 0 is "the driver runs", and the init
 * sets them together. `gs+0x1f5` is not a user switch but the return value of a driver query; its
 * counterpart in the port is "archive present and FM synth initialised" - the same role, an environment
 * property the user does not set.
 *
 * The switch in the options screen is not merely a flag toggle but starts and stops the player, and
 * without a driver it stays ineffective.
 *
 * NOT tied to pausing: that the mission end stops the music is a separate call beside
 * `pause_game_clock`, not a side effect of it. The original knows no pause otherwise, so pausing our
 * simulation must not stop the music.
 */

/**
 * Archive index of the **game music**, 0-based (DOS index 3990, `mov $0xf96` @0xb162). An `.XMI`
 * stream, not a sprite.
 */
export const MUSIC_ARCHIVE_GAME = 3989;

/**
 * Archive index of the **end credits music**, 0-based (DOS index 3992, `mov $0xf98` @0x38b71). Its
 * consumer is `core/end-credits.ts`, which starts it and switches back to {@link MUSIC_ARCHIVE_GAME}
 * at the end (`mov $0xf96` @0x38f7e).
 */
export const MUSIC_ARCHIVE_ENDING = 3991;

/**
 * **Does music play?** — the conjunction from `@0x4500`/`@0x450f`: the driver must be present **and**
 * the user must want it. In the original those are `gs+0x1f5 == 0` and `gs+0x3da != 0`, mirrored live
 * in `gs+0x1cb` bit 0 and bit 1.
 *
 * @param driverReady counterpart to `gs[0x1f5] == 0` — in the port: archive loaded and synth ready.
 * @param musicOption counterpart to `gs+0x1cb` bit 1 — the checkbox in options screen 0x25.
 */
export function musicShouldPlay(driverReady: boolean, musicOption: boolean): boolean {
  return driverReady && musicOption;
}
