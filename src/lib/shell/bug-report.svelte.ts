/**
 * Bus for the bug report.
 *
 * The report is assembled by the game view (only it knows state, camera and canvas) but triggered
 * from the shell's debug overlay. Rather than making the view carry that UI, it registers a
 * collector here while it is mounted — the same pattern as the log bus.
 *
 * THE REPORT GOES NOWHERE, and NOTHING OF IT IS KEPT. One click builds the package, hands it to the
 * browser as a download and steers a tab at the prefilled issue; afterwards this bus holds only
 * whether that worked. Keeping the finished package around bought nothing: the file is on disk, the
 * issue is open, and the reminder to attach it rides along in the issue body itself as a checkbox
 * (see `views/debug-export.ts::issueBody`) — the only place that can still reach the reporter after
 * they have submitted.
 */
import type { DebugReport } from '../views/debug-export.js';

export type BugReportCollector = (note: string) => Promise<DebugReport>;

class BugReportBus {
	#collect: BugReportCollector | null = $state(null);
	/**
	 * Report dialog open. The simulation pauses meanwhile: the report should describe the state the
	 * reporter saw, not the one after thirty seconds of typing.
	 */
	composing = $state(false);
	/** Building is running. */
	busy = $state(false);
	/** The last run got through — file saved and issue opened. */
	filed = $state(false);
	/** Why it failed, if it did. */
	error = $state<string | null>(null);
	/** Is a view mounted that can supply a report? */
	available = $derived(this.#collect !== null);

	/** Register. Returns the unregister function — fits straight into an `$effect` return. */
	provide(collect: BugReportCollector): () => void {
		this.#collect = collect;
		return () => {
			if (this.#collect === collect) this.#collect = null;
		};
	}

	/**
	 * Build the report, save it, open the issue. All three happen here and not in the panel so that
	 * a failure at any of them surfaces in the same place — a silent failure would be the worst
	 * outcome while debugging.
	 */
	async create(note: string): Promise<boolean> {
		const collect = this.#collect;
		if (collect === null || this.busy) return false;
		this.busy = true;
		this.filed = false;
		this.error = null;
		// The tab is opened NOW, still inside the click that led here, and starts out empty: building
		// takes a moment, and after an `await` the browser has withdrawn the transient activation, so
		// a pop-up blocker would swallow the window. It is steered at the issue once the package
		// exists, and closed again if building fails.
		const tab = openBlankTab();
		try {
			const report = await collect(note);
			download(report.fileName, report.bytes);
			if (!showIssue(tab, report.issueUrl)) {
				throw new Error('Could not open the issue page — allow pop-ups for this site and retry.');
			}
			this.filed = true;
			return true;
		} catch (err) {
			tab?.close();
			this.error = err instanceof Error ? err.message : String(err);
			return false;
		} finally {
			this.busy = false;
		}
	}
}

/** An empty tab, or `null` when the browser refused. */
function openBlankTab(): Window | null {
	// No `noopener` here on purpose: with that feature `window.open` returns null and the tab could
	// not be steered afterwards. The link back is cut below instead.
	try {
		return window.open('', '_blank');
	} catch {
		return null;
	}
}

/**
 * Send the tab to the issue. Second attempt if the empty tab was refused earlier — by then the
 * gesture is gone, so it may fail; `false` says so instead of leaving the reporter with a file and
 * no idea where it goes.
 */
function showIssue(tab: Window | null, url: string): boolean {
	if (tab === null) return window.open(url, '_blank', 'noopener') !== null;
	// Cut the link back before handing the tab to a foreign site.
	try {
		tab.opener = null;
	} catch {
		/* not settable in every browser — the navigation matters more */
	}
	tab.location.replace(url);
	return true;
}

/**
 * Hand a blob to the browser as a file. `URL.revokeObjectURL` only on the next macrotask — revoking
 * right away aborts the download in some browsers because the click has not been processed yet.
 */
function download(fileName: string, bytes: Uint8Array): void {
	const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/zip' }));
	const a = document.createElement('a');
	a.href = url;
	a.download = fileName;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const bugReports = new BugReportBus();
