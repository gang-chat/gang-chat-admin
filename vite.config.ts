import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

type SvelteKitBasePath = '' | `/${string}`;

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	// The console is a static page the Go server's nginx serves under /admin;
	// ADMIN_BASE_PATH moves it.
	const basePath = normalizeBasePath(env.ADMIN_BASE_PATH ?? '/admin');
	// `npm run dev` sends /gang-chat/* to a gang-chat server on this machine,
	// with the prefix stripped as nginx does.
	const devServer = env.GANG_CHAT_SERVER ?? 'http://127.0.0.1:21116';

	return {
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
				adapter: adapter({ fallback: 'index.html' })
			})
		],
		server: {
			proxy: {
				'/gang-chat/': {
					target: devServer,
					changeOrigin: true,
					rewrite: (path) => path.replace(/^\/gang-chat/, '')
				}
			}
		}
	};
});

function normalizeBasePath(input: string): SvelteKitBasePath {
	const value = input.trim();
	if (!value || value === '/') return '';
	if (!value.startsWith('/') || value.endsWith('/')) {
		throw new Error('ADMIN_BASE_PATH must start with / and not end with /');
	}
	return value as `/${string}`;
}
