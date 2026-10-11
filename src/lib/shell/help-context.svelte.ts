/**
 * Which original dialog is open in the game — so the help can open on the page that explains it.
 *
 * The game view knows its popup slot, the help lives in the shell; the same bus pattern as
 * `simulation.svelte.ts`. `null` = no dialog open, or no game.
 */
class HelpContextBus {
	openScreen = $state<number | null>(null);
}

export const helpContext = new HelpContextBus();
