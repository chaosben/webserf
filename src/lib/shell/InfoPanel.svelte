<script lang="ts">
	/**
	 * WHAT THIS IS AND WHERE IT COMES FROM — the screen that used to be "developer tools".
	 *
	 * It replaced them because the two notes there addressed a developer standing in front of their
	 * own devtools, while the one question a visitor actually arrives with had no place at all:
	 * what am I looking at, who made it, and where is the source. The log hint survives as the last
	 * paragraph — it costs one line and helps exactly the person who now has to write a report.
	 */
	import { st } from './i18n.js';
	import { PROJECT_REPO, PROJECT_URL } from './project.js';
</script>

<section>
	<h3>{st('info.about.title')}</h3>
	<p class="note">{st('info.about.what')}</p>
	<p class="note">{st('info.about.assets')}</p>
</section>

<section>
	<h3>{st('info.source.title')}</h3>
	<p class="note">
		<a href={PROJECT_URL} target="_blank" rel="noreferrer noopener">{PROJECT_REPO}</a>
	</p>
	<p class="note">{st('info.source.note')}</p>
</section>

<section>
	<h3>{st('info.original.title')}</h3>
	<p class="note">
		{st('info.original.note')}
		<a href={st('link.store')} target="_blank" rel="noreferrer noopener">
			{st('info.original.link')}
		</a>
	</p>
</section>

<section>
	<h3>{st('info.legal.title')}</h3>
	<p class="note">{st('info.legal.note')}</p>
</section>

<section>
	<h3>{st('info.log.title')}</h3>
	<p class="note">{st('info.log.note')}</p>
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

	.note {
		margin: 0;
		color: var(--fg-dim);
		line-height: 1.5;
	}

	.note a {
		color: var(--accent);
	}
</style>
