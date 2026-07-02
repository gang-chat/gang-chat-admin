import { buildApp } from './app';
import { loadEnv } from './config/env';

const env = await loadEnv();
const app = await buildApp(env);

try {
	await app.listen({ host: env.host, port: env.port });
	app.log.info(`Ops API listening on http://${env.host}:${env.port}`);
	if (env.nodeEnv !== 'production' && env.apiToken === 'dev-admin-token') {
		app.log.warn('Using development admin token: dev-admin-token');
	}
} catch (error) {
	app.log.error(error);
	process.exit(1);
}
