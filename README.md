# Gang Chat Ops Admin

The operations console for Gang Chat: a static SvelteKit page that talks to the gang-chat
server's admin API (`/api/v1/admin/*`, in gang-chat-server `internal/admin`). There is no
backend here any more; the Go server holds the database, the files and the console's sign-in.

## What Is Included

- Releases: the client versions the homepage shows, with their notes,
  release date, minimum supported version, download links and whether they are published.
- A file manager for the server's storage directory (`storage_path`): upload, download, delete,
  and GitHub release sync.
- Gang Chat account admin: accounts, sign-in access, and room membership and roles.
- A read-only view of the server's SQLite database.

Every change, including refused and failed attempts, is written to the server's
`admin_audit_log` table.

## Configuration

The console's settings live in the gang-chat server's `config.json`:

```json
{
	"admin_username": "ops",
	"admin_password": "at least 14 characters with lower, upper, digit and symbol",

	"release_sync_repository_url": "https://github.com/gang-chat/gang-chat-client",
	"release_sync_asset_prefix": "GangChat",
	"release_sync_github_token": "optional, for private repos or a higher rate limit",
	"release_download_base_url": "https://ky-z.com/gang-chat/assets/releases"
}
```

The console stays off (the API answers `503 ADMIN_DISABLED`) until `admin_username` and a strong
`admin_password` are set; the server log says what is missing. The password must have at least
14 characters, a lowercase and an uppercase letter, a digit and a symbol, and must not contain
the username or common words such as `password` or `admin`. Eight wrong passwords lock sign-in
for 15 minutes. Sessions last 30 days, or until they go unused for a day.

The file manager shows the server's `storage_path`: chat uploads under `assets/<asset id>/`, the
synced client release under `assets/releases/`.

## Releases

Each version has a title, notes, a release date, a published flag, a minimum supported version
and Windows, macOS and Android download links. The newest published version is the version and download buttons on the homepage, which reads
`GET /api/v1/releases`. `GET /api/v1/app/version` reports it too, with its minimum supported
version (empty means the version itself); current clients check for updates against the
`appcast.xml` and `latest.yml` that release sync puts next to the installers instead, so the
minimum is not enforced anywhere yet.

Every published version with notes shows on the homepage as an announcement. Drafts are hidden
from both. Deleting a version removes its row only; its files on the server stay.

## Account Admin

Reading and changing accounts needs only a console session. Deleting an account needs the exact
username typed as confirmation.

| Action               | What it writes                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------- |
| Create               | A new active user with a verified email, the next free UID and an argon2id password hash |
| Edit                 | Username, email (marks it unverified unless you tick verified), display name             |
| Suspend / reactivate | `users.status`; suspending also signs the account out everywhere                         |
| Sign out everywhere  | Revokes all of the account's sessions                                                    |
| Reset password       | New hash, and every session is signed out                                                |
| Delete               | The user and everything that cascades from it; their messages stay with a name snapshot  |
| Rooms and roles      | Add to a room, change member/admin, make owner, remove from a room                       |

Each write runs in one transaction and reuses the server's own code for the same action
(`internal/model` and `internal/auth`), so the rows look as if a client made the change. It does
not publish the server's realtime events or room system messages: open clients see changes on
their next refresh. The server checks session revocation and account status on every request,
so suspensions and sign-outs take effect immediately. Other rules it keeps:

- The super user (`GANG`, UID 66666666) is read only here; the server resets it on every start.
- A room's owner keeps that role until another member is made owner, which turns the old owner
  into an admin. The owner can't be removed from the room.
- Blacklisted users can't be added to that room.
- Deleting an account first copies the sender's name onto their messages, so message history
  stays readable.

## Release Sync

When `release_sync_repository_url` is set, the server copies the repository's GitHub releases
into `assets/releases/` under its `storage_path` and serves them at `/assets/releases/<file>`
(`https://ky-z.com/gang-chat/assets/releases/`), with range requests, so downloads resume and
electron-updater can fetch only the changed blocks.

New releases sync on their own: every five minutes the server checks the repository's latest
release, and syncs it once the release workflow (`.github/workflows/release.yml`) run on its tag
has succeeded. GitHub lists a release while that run is still uploading its files, so the server
waits for the run. A rerun of a failed job counts. A tag synced once, from the console or on its
own, is not synced on its own again, so a version deleted or rolled back here stays that way. The
file manager can also sync any tag by hand; one sync runs at a time.

The sync clears `assets/releases/`, then selects the first `.dmg`, `.exe`, and `.apk` asset from the
release and stores them as `<assetPrefix>_<tag>.dmg`, `<assetPrefix>_<tag>.exe`, and
`<assetPrefix>_<tag>.apk`. If the release has a blockmap for that `.exe` (`<exe name>.blockmap`,
from electron-builder), it is stored as `<assetPrefix>_<tag>.exe.blockmap`. Clearing keeps earlier
`.blockmap` files: the Windows app's electron-updater downloads the installed version's blockmap
next to the new one to fetch only the changed blocks.

The update feeds are stored last under their fixed names, and served with
`Cache-Control: no-cache`, because they point at the installers:

- `appcast.xml`, the macOS client's Sparkle feed (`Content-Type: application/xml`). Before
  anything is cleared, the sync checks that every update in it downloads the `.dmg` this sync
  stores, from `release_download_base_url` (`<base>/<assetPrefix>_<tag>.dmg`); if not, it fails
  with `RELEASE_APPCAST_MISMATCH`.
- `latest.yml`, the Windows client's electron-updater feed (`Content-Type: text/yaml`). Its
  `path` and every `files` URL must be the `.exe` this sync stores
  (`<assetPrefix>_<tag>.exe`); if not, it fails with `RELEASE_LATEST_YML_MISMATCH`.

A failed check leaves the stored release unchanged. All assets are downloaded before anything
is cleared, so a GitHub failure also leaves it as it was.

After a sync, the version's release row points at the stored installers, under
`release_download_base_url`. A version the console
has never seen is created published, titled `Gang Chat <version>` and dated from GitHub's
publish time (Beijing time); an existing one keeps its notes and visibility. Links on other
versions to installers the sync removed are cleared.

## Deployment

`npm run build` writes a static site to `build/`. Serve it under `/admin/` and send every path
there to `index.html`; the page calls the API at `/gang-chat/api/v1` on the same origin:

```nginx
location = /admin {
    return 301 /admin/;
}
location ^~ /admin/ {
    alias /var/www/gang-chat-admin/;
    try_files $uri $uri/ /admin/index.html;
}
```

Every push to `main` that passes CI is deployed by the `deploy` job in
`.github/workflows/ci.yml`: it builds, rsyncs `build/` into `/var/www/gang-chat-admin/` on the
server, and checks that `https://ky-z.com/admin/_app/version.json` matches the build. Its
secrets are the same as gang-chat-server's deploy: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`,
and `DEPLOY_PORT` when SSH is not on 22.

Build-time variables (in the environment or a `.env` file):

| Variable          | Default             | What it does                    |
| ----------------- | ------------------- | ------------------------------- |
| `ADMIN_BASE_PATH` | `/admin`            | Where the page is served        |
| `VITE_API_BASE`   | `/gang-chat/api/v1` | The gang-chat server's API root |

## Run Locally

Start a gang-chat server on `127.0.0.1:21116` with `admin_username` and `admin_password` in its
config, then:

```sh
npm install
npm run dev
```

Open `http://localhost:5173/admin/`. The dev server forwards `/gang-chat/*` to the gang-chat
server with the prefix stripped, as nginx does; set `GANG_CHAT_SERVER` to use another address.

## Scripts

```sh
npm run dev          # Vite dev server with the API proxy
npm run check        # Svelte and TypeScript checks
npm run lint         # Prettier and ESLint
npm run build        # static site in build/
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

- Serve the console and the API over TLS only; the session token is a bearer token.
- The console account is separate from the app's super user; give it its own password.
