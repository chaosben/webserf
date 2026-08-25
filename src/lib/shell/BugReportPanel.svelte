<script lang="ts">
	/**
	 * Trigger a bug report. The report is assembled by the game view (`bugReports`), then packed and
	 * downloaded IN THE BROWSER — there is no endpoint and no upload limit to show here.
	 *
	 * ONE BUTTON, and afterwards this panel holds nothing: the file is saved and the prefilled issue
	 * opens in a new tab in the same step. The one thing the reporter still has to do — drag the file
	 * in, because GitHub has no API for attachments — is asked for INSIDE THE ISSUE as a checkbox
	 * (`views/debug-export.ts::issueBody`). A line here could not: by the time it matters, this panel
	 * is out of sight.
	 *
	 * What becomes of a report is deliberately not shown here: the state of a bug lives in the
	 * repository, and the reporter learns about it from the changelog of the next deployment.
	 */
	import { bugReports } from './bug-report.svelte.js';
	import { log } from './log.js';
	import { st } from './i18n.js';
	import { PROJECT_ISSUES_URL, PROJECT_REPO } from './project.js';

	let note = $state('');

	async function submit(): Promise<void> {
		const ok = await bugReports.create(note);
		if (ok) {
			note = '';
			log.info('bug', 'Report built, saved and issue opened');
		} else {
			log.warn('bug', `Report failed: ${bugReports.error ?? 'unknown'}`);
		}
	}

	// While this dialog is open the simulation is held (see `bugReports.composing`).
	$effect(() => {
		bugReports.composing = true;
		return () => {
			bugReports.composing = false;
		};
	});
</script>

<p class="note">{st('bug.intro')}</p>

<p class="note">
	{st('bug.where')}
	<a href={PROJECT_ISSUES_URL} target="_blank" rel="noreferrer noopener">{PROJECT_REPO}</a>
</p>

<label>
	{st('bug.what')}
	<textarea
		bind:value={note}
		rows="4"
		placeholder={st('bug.placeholder')}
		disabled={bugReports.busy}
	></textarea>
</label>

<div class="row">
	<button type="button" onclick={() => void submit()} disabled={!bugReports.available || bugReports.busy}>
		{bugReports.busy ? st('bug.building') : st('bug.build')}
	</button>
</div>

{#if !bugReports.available}
	<p class="note">{st('bug.needGame')}</p>
{/if}

{#if bugReports.error !== null}
	<p class="warn">{bugReports.error}</p>
{/if}

{#if bugReports.filed}
	<p class="note">{st('bug.filed')}</p>
{/if}

<style>
	label {
		display: grid;
		gap: 0.25rem;
		color: var(--fg-dim);
	}

	textarea {
		font: inherit;
		color: inherit;
		background: var(--bg-sunken);
		border: 1px solid var(--line);
		resize: vertical;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.note {
		margin: 0;
		color: var(--fg-dim);
		line-height: 1.5;
	}

	.warn {
		margin: 0;
		color: var(--amber);
	}

	.note a {
		color: var(--accent);
	}
</style>
