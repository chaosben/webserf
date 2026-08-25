import adapterNode from '@sveltejs/adapter-node';
import adapterCloudflare from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vitest/config';

const adapter = process.env.ADAPTER === 'cloudflare' ? adapterCloudflare() : adapterNode();

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Runes-Modus fuer das ganze Projekt erzwingen (ausser Bibliotheken).
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			
			adapter
		}),
		Icons({ compiler: 'svelte' })
	],
	test: {
		globals: true,
		environment: 'node',
		include: ['src/**/*.{test,spec}.ts']
	}
});
