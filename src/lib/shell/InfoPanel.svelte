<script lang="ts">
	/**
	 * WHAT THIS IS AND WHERE IT COMES FROM — the one question a visitor arrives with: what am I
	 * looking at, who made it, and where is the source.
	 *
	 * It is deliberately not a developer screen: notes for someone standing in front of their own
	 * devtools have no audience here. The log hint is the exception and stays as the last paragraph —
	 * it costs one line and helps exactly the person who has to write a report.
	 *
	 * The waiting version belongs here because the build stamp does: this is the screen that answers
	 * "which version am I running", and the restart is the same question in the other direction.
	 */
	import { commitDateText, commitUrl, shortCommit } from "./build-info.js";
	import { shellLanguage, st } from "./i18n.js";
	import { PROJECT_REPO, PROJECT_URL } from "./project.js";
	import { updates } from "./update.svelte.js";

	const commit = shortCommit();
	const commitLink = commitUrl();
	const commitDate = commitDateText(shellLanguage());
</script>

{#if updates.ready || updates.switched}
	<section>
		<h3>{st("update.title")}</h3>
		<p class="note">
			{#if updates.switched}{st("update.switched")}{:else}{st("update.ready")}{/if}
		</p>
		<p class="act">
			<button type="button" onclick={() => updates.apply()} disabled={updates.applying}>
				{st("update.apply")}
			</button>
		</p>
	</section>
{/if}

<section>
	<h3>{st("info.about.title")}</h3>
	<p class="note">{st("info.about.what")}</p>
	<p class="note">{st("info.about.assets")}</p>
</section>

<section>
	<h3>{st("info.source.title")}</h3>
	<p class="note">
		<a href={PROJECT_URL} target="_blank" rel="noreferrer noopener">{PROJECT_REPO}</a>
	</p>
	<p class="note">{st("info.source.note")}</p>
</section>

<section>
	<h3>{st("info.build.title")}</h3>
	<p class="note">
		{#if commit === null}
			{st("info.build.unknown")}
		{:else}
			<!--
				A DIRTY BUILD IS NOT THAT COMMIT, so it carries no link: the page on the forge would
				show different code than what is running here. The hash still says what this is a
				change on top of, which is why it stays.
			-->
			{#if commitLink === null}
				<code>{commit}</code>
			{:else}
				<a href={commitLink} target="_blank" rel="noreferrer noopener"><code>{commit}</code></a>
			{/if}
			{#if commitDate !== null}&nbsp;· {commitDate}{/if}
			{#if commitLink === null}&nbsp;— {st("info.build.modified")}{/if}
		{/if}
	</p>
</section>

<section>
	<h3>{st("info.original.title")}</h3>
	<p class="note">
		{st("info.original.note")}
		<a href={st("link.store")} target="_blank" rel="noreferrer noopener">
			{st("info.original.link")}
		</a>
	</p>
</section>

<section>
	<h3>{st("info.legal.title")}</h3>
	<p class="note">{st("info.legal.note")}</p>
</section>

<style>
	section {
		display: grid;
		gap: 0.4rem;
	}

	section h3 {
		margin: 0;
		font-size: 1em;
		font-weight: normal;
		color: var(--fg-dim);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	/* Wraps the button so it keeps its own width — a bare grid child would stretch across. */
	.act {
		margin: 0;
	}

	.note {
		margin: 0;
		color: var(--fg-dim);
		line-height: 1.5;
	}

	.note a {
		color: var(--accent);
	}

	.note code {
		font-family: inherit;
		letter-spacing: 0.04em;
	}
</style>
