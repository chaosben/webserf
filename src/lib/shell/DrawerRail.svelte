<script lang="ts">
	/**
	 * The rail on the left. Collapsed it is just a column of small icons; each icon is a GROUP of
	 * commands whose panel is laid over the game surface as an overlay.
	 */
	import type { DrawerGroup } from './drawer.js';
	import { st } from './i18n.js';

	let {
		groups,
		active,
		onselect
	}: {
		groups: readonly DrawerGroup[];
		active: string | null;
		onselect: (id: string | null) => void;
	} = $props();
</script>

<nav aria-label={st('rail.aria')}>
	{#each groups as group (group.id)}
		{@const Icon = group.icon}
		{@const label = st(group.labelKey)}
		<button
			type="button"
			class:active={active === group.id}
			title={label}
			aria-label={label}
			aria-pressed={active === group.id}
			onclick={() => onselect(active === group.id ? null : group.id)}
		>
			<Icon />
		</button>
	{/each}
</nav>

<style>
	nav {
		display: flex;
		flex-direction: column;
		gap: 1px;
		width: 2.75rem;
		padding: 1px;
		background: var(--bg-sunken);
		border-right: 1px solid var(--line);
	}

	button {
		border: none;
		background: none;
		height: 2.75rem;
		color: var(--fg-dim);
		display: grid;
		place-items: center;
	}

	/* The icon component carries its own size; the rail's size wins here. */
	button :global(svg) {
		width: 1.5rem;
		height: 1.5rem;
	}

	button:hover {
		background: var(--bg-raised);
		color: var(--accent);
	}

	button.active {
		background: var(--bg-raised);
		color: var(--amber);
		box-shadow: inset 2px 0 0 var(--amber);
	}
</style>
