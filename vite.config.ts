import { execSync } from 'node:child_process';
import adapterNode from '@sveltejs/adapter-node';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vitest/config';

const adapter = process.env.ADAPTER === 'cloudflare' ? adapterCloudflare() : adapterNode();

/**
 * WHICH COMMIT THIS BUILD CAME FROM.
 *
 * This folder is its own repository, so the build can name its own origin without knowing anything
 * outside it. A copy without git — a tarball, a fresh unpack, a CI checkout without history — must
 * still build: every failure lands in `commit: null`, and the interface then says "unknown" instead
 * of claiming an origin it does not have.
 */
function readBuildInfo() {
	const git = (args: string) =>
		execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	try {
		return {
			commit: git('rev-parse HEAD'),
			commitDate: git('log -1 --format=%cI'),
			dirty: git('status --porcelain') !== ''
		};
	} catch {
		return { commit: null, commitDate: null, dirty: false };
	}
}

const buildInfo = readBuildInfo();

/**
 * SvelteKit's own version string names the service worker cache (`webserf-${version}`). The commit
 * is the better key than the default timestamp, because two builds of the same commit then share a
 * cache instead of invalidating it for nothing.
 *
 * ONLY WHEN THE TREE IS CLEAN. A dirty tree produces different code under the same commit, so
 * several distinct builds would carry one key and the service worker would keep serving the older
 * one. Without a name SvelteKit falls back to the timestamp, which is exactly right there.
 */
const version = buildInfo.commit !== null && !buildInfo.dirty ? { name: buildInfo.commit } : undefined;

export default defineConfig({
	define: {
		__BUILD_INFO__: JSON.stringify(buildInfo)
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				// Runes-Modus fuer das ganze Projekt erzwingen (ausser Bibliotheken).
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			adapter,
			version
		}),
		Icons({ compiler: 'svelte' })
	],
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.{test,spec}.ts']
	}
});
