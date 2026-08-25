/// <reference types="unplugin-icons/types/svelte" />
// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	/**
	 * The one build-time constant of this application, substituted by `vite.config.ts`. `commit` is
	 * `null` in a copy built without git history — every reader has to handle that case.
	 *
	 * It lives inside `declare global` because this file is a module (it has an `export`), so a
	 * top-level declaration would only be visible here.
	 */
	const __BUILD_INFO__: {
		readonly commit: string | null;
		readonly commitDate: string | null;
		readonly dirty: boolean;
	};
}

export {};
