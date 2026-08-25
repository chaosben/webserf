/**
 * Watchdog for the icon chain: the rail icons must come from the LOCAL
 * `@iconify-json/material-symbols-light` package and be inlined at build time by `unplugin-icons`.
 * If the Vite plugin falls out of the config this import breaks — without the test that would only
 * surface at build time, and the obvious "fix" would be a CDN.
 */
import { expect, it } from 'vitest';
import IconBug from '~icons/material-symbols-light/bug-report-outline';
import IconSettings from '~icons/material-symbols-light/settings-outline';

it('builds the rail icons from the local package', () => {
  expect(typeof IconBug).toBe('function');
  expect(typeof IconSettings).toBe('function');
});
