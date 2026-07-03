# Gang Chat Ops Admin

SvelteKit + Fastify operations panel for Gang Chat infrastructure.

## What Is Included

- MySQL workbench for table browsing.
- S3-compatible single-bucket file manager with upload, download and delete actions.
- Multi-pane SSH terminal workspace over WebSocket.
- Pi Agent suggestion entry and manual cost ledger.
- Session login and role-based access.

## Configuration

The API does not read `.env`. It requires an explicit JSON config file and defaults to `config.json` in the project root. Use `--config path/to/config.json` to load another file.

Required login credentials are configured directly in `config.json`:

```json
{
	"adminUsername": "admin",
	"adminPassword": "dev-admin-password"
}
```

The server refuses to start if required config fields are missing. In production, `adminPassword` must satisfy the backend password policy.

Connection presets are also configured in `config.json` and are read-only at runtime. MySQL has one connection, S3 has one connection bound to one bucket, and SSH supports multiple hosts:

```json
{
	"connections": {
		"mysql": {
			"id": "main-db",
			"type": "mysql",
			"name": "Main DB",
			"config": {
				"host": "127.0.0.1",
				"port": 3306,
				"database": "gang_chat",
				"user": "gang_ops",
				"password": "change-me",
				"ssl": false,
				"allowMutations": false
			}
		},
		"s3": {
			"id": "main-s3",
			"type": "s3",
			"name": "Object Storage",
			"config": {
				"endpoint": "https://s3.example.com",
				"region": "us-east-1",
				"defaultBucket": "gang-chat-assets",
				"forcePathStyle": true,
				"allowWrites": false,
				"accessKeyId": "change-me",
				"secretAccessKey": "change-me"
			}
		},
		"ssh": [
			{
				"id": "pi-1",
				"type": "ssh",
				"name": "Pi 1",
				"config": {
					"host": "192.168.1.10",
					"port": 22,
					"username": "pi",
					"password": "change-me"
				}
			}
		]
	}
}
```

GitHub release sync is optional. When configured, the S3 panel can list release versions from the repository and sync the selected release assets into the configured object prefix:

```json
{
	"releaseSync": {
		"repositoryUrl": "https://github.com/owner/repo",
		"targetPrefix": "releases/current/",
		"assetPrefix": "GangChat",
		"githubToken": "optional-for-private-repos"
	}
}
```

If the admin app is mounted below a route prefix, configure it in `config.json`:

```json
{
	"basePath": "/admin",
	"corsOrigin": ["http://ky-z.com"]
}
```

With `basePath` set to `/admin`, the same backend process serves the page, API, and WebSocket endpoints under that prefix:

- Page: `/admin/`
- API: `/admin/api/...`
- WebSocket: `/admin/ws/...`
- SvelteKit assets: `/admin/_app/...`

Build the web app with the same config file used at runtime:

```sh
GANG_CHAT_ADMIN_CONFIG=/path/to/config.json npm run build
npm run start -- --config /path/to/config.json
```

## Run Locally

```sh
npm install
npm run dev
```

Default URL:

- App, API, and WebSocket: `http://127.0.0.1:8787`
- Login: `admin` / `admin`

Run API with another config file:

```sh
npm run dev:api -- --config /path/to/config.json
```

## Scripts

```sh
npm run dev          # API + frontend
npm run dev:api      # same single backend as npm run dev
npm run check        # Svelte/frontend type checks
npm run check:api    # backend TypeScript check
npm run test:api     # backend tests
npm run build        # frontend build + API bundle
```

## Security Notes

- Do not expose the API without TLS.
- Use a unique 32+ byte `secretKey` per deployment.
- Pin SSH host keys with `hostKeySha256` for production SSH presets.
- MySQL and S3 writes require the preset write flags plus existing destructive confirmations.
