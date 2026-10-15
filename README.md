# Gang Chat Ops Admin

SvelteKit + Fastify operations panel for Gang Chat infrastructure.

## What Is Included

- MySQL workbench for table browsing.
- S3-compatible single-bucket file manager with upload, download and delete actions.
- Gang Chat account admin: accounts, sign-in access, and room membership and roles.
- Session login and role-based access.

The console has no shell or command execution: the SSH terminal and the AI admin worker were
removed. Old `config.json` keys for them (`agentWorkerToken`, `aiAdminWorker`, `ssh*`,
`connections.ssh`) are ignored and can be deleted.

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

Connection presets are also configured in `config.json` and are read-only at runtime. MySQL has one connection and S3 has one connection bound to one bucket:

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
		}
	}
}
```

## Account Admin

The Accounts panel manages Gang Chat users directly in the Gang Chat database, through the
`connections.mysql` preset (so that preset must point at the Gang Chat database). Reading needs
any role; changes need the `operator` role and `allowMutations: true` on the preset; deleting an
account needs the `admin` role and the exact username typed as confirmation. Every change is
recorded in the audit log, including refused and failed attempts.

| Action               | What it writes                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Create               | A new active user with a verified email, the next free UID and an argon2id password hash |
| Edit                 | Username, email (marks it unverified unless you tick verified), display name             |
| Suspend / reactivate | `users.status`; suspending also signs the account out everywhere                         |
| Sign out everywhere  | Revokes all of the account's sessions                                                    |
| Reset password       | New hash, and every session is signed out                                                |
| Delete               | The user and everything that cascades from it; their messages stay with a name snapshot  |
| Rooms and roles      | Add to a room, change member/admin, make owner, remove from a room                       |

Each write runs in one transaction and mirrors the SQL the Gang Chat server runs for the same
action (`internal/auth` and `internal/chat` in gang-chat-server), so the rows look as if the
server wrote them. Because it bypasses the server, it does not publish the server's realtime
events or room system messages: open clients see changes on their next refresh. The server
checks session revocation and account status on every request, so suspensions and sign-outs
take effect immediately. Other rules it keeps:

- The super user (`GANG`, UID 66666666) is read only here; the server resets it on every start.
- A room's owner keeps that role until another member is made owner, which turns the old owner
  into an admin. The owner can't be removed from the room.
- Blacklisted users can't be added to that room.
- Delete refuses to run until the database has the server's message-retention schema (message
  sender snapshots, no cascading message foreign key), so it can never erase message history.
  The server applies that schema when it starts.
- Creating an account needs the server's `id_sequences` table, which the server creates.

The MySQL user only needs `SELECT`, `INSERT`, `UPDATE` and `DELETE` on the Gang Chat database.

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

The sync clears the target prefix, then selects the first `.dmg`, `.exe`, and `.apk` asset from the
release and stores them as `<assetPrefix>_<tag>.dmg`, `<assetPrefix>_<tag>.exe`, and
`<assetPrefix>_<tag>.apk`.

If the release also has an `appcast.xml` (the macOS client's Sparkle update feed), it is uploaded
last under that fixed name, with `Content-Type: application/xml` and `Cache-Control: no-cache`.
Before anything is cleared, the sync checks that every update in the appcast downloads the
`.dmg` this sync uploads (`<targetPrefix><assetPrefix>_<tag>.dmg`); if not, it fails with
`RELEASE_APPCAST_MISMATCH` and leaves the bucket unchanged.

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

## Design

The UI uses the Gang Chat client's Signal design (gang-chat-client `docs/ui-design-system.md`,
`lib/src/ui/tokens.dart`), the same as the homepage. It is dark only: a near-black dotted canvas,
layered dark panels, and one lime signal colour (`#D4FF3F`) reserved for what is live or can be
pressed. Selection is an inverse white pill. The tokens live in `src/routes/layout.css` and are
mapped onto the shadcn-svelte roles, so the components under `src/lib/components/ui` pick them up.

Space Grotesk, JetBrains Mono and Doto are self-hosted as Latin-subset WOFF files in
`src/lib/assets/fonts` (OFL, licences alongside); Chinese text falls back to the system font. Do
not switch them to Google Fonts, which is unreliable in mainland China. The brand mark
`src/lib/assets/gang_chat.svg` (also `static/favicon.svg`) is the client's.

## Security Notes

- Do not expose the API without TLS.
- Use a unique 32+ byte `secretKey` per deployment.
- MySQL and S3 writes require the preset write flags plus existing destructive confirmations.
