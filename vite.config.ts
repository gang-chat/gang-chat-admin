import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const basePath = loadBasePath();
type SvelteKitBasePath = '' | `/${string}`;

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			paths: {
				base: basePath
			},
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			adapter: adapter()
		})
	]
});

function loadBasePath(): SvelteKitBasePath {
	const configPath = path.resolve(
		process.env.GANG_CHAT_ADMIN_CONFIG ||
			process.env.ADMIN_CONFIG ||
			cliJsonConfigPath() ||
			'config.json'
	);
	if (!existsSync(configPath)) return '';
	const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { basePath?: string };
	return normalizeBasePath(raw.basePath ?? '');
}

function cliJsonConfigPath() {
	const index = process.argv.indexOf('--config');
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (!value?.toLowerCase().endsWith('.json')) return undefined;
	return value;
}

function normalizeBasePath(input: string): SvelteKitBasePath {
	const value = input.trim();
	if (!value || value === '/') return '';
	if (!value.startsWith('/')) throw new Error('basePath must start with / in config.json');
	if (value.endsWith('/')) throw new Error('basePath must not end with / in config.json');
	if (value.length > 128) throw new Error('basePath is too long in config.json');
	if (hasControlCharacter(value)) throw new Error('basePath cannot contain control characters');
	if (value.split('/').some((part) => part === '..')) {
		throw new Error('basePath cannot contain .. path segments');
	}
	return value as `/${string}`;
}

function hasControlCharacter(value: string) {
	return Array.from(value).some((char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127;
	});
}
