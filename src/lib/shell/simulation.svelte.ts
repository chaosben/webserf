/**
 * Bus for controlling the running simulation.
 *
 * The clock belongs to the game view — only it knows the scheduler, the game state and the screens
 * that the original stops by itself (quit dialog, mission end). It is operated from the shell's
 * settings overlay, though. Rather than making the view carry that UI, it registers here while it
 * is mounted — the same pattern as the log and bug-report buses.
 *
 * `running` is the user's WISH and deliberately not persisted: a session that reopens paused looks
 * like a bug. Whether the simulation actually steps is {@link active} — the original stops the
 * clock in several places on its own, and those reasons are not the user's to override.
 *
 * SPEED is not held here but in the settings: it is meant to persist.
 */
class SimulationBus {
	/** Is a game view with a clock mounted? */
	present = $state(false);
	/** Run state as requested by the user. */
	running = $state(true);
	/** What the view makes of it — also `false` while an original screen holds the clock. */
	active = $state(false);

	/**
	 * Register. Returns the unregister function — fits straight into an `$effect` return.
	 * A freshly opened game runs, no matter how the previous one was left.
	 */
	provide(): () => void {
		this.present = true;
		this.running = true;
		return () => {
			this.present = false;
			this.active = false;
		};
	}

	toggle(): void {
		if (this.present) this.running = !this.running;
	}
}

export const simulation = new SimulationBus();
