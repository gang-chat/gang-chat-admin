import { buildApp } from './app';
import { loadConfig } from './config/config';

const config = await loadConfig();
const app = await buildApp(config);

try {
	await app.listen({ host: config.host, port: config.port });
	app.log.info(`Ops API listening on http://${config.host}:${config.port}`);
} catch (error) {
	app.log.error(error);
	process.exit(1);
}
