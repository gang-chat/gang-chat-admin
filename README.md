# Gang Chat Ops Admin

Frontend/backend separated operations panel for Gang Chat infrastructure.

## What Is Included

- SvelteKit frontend workbench with MySQL, S3, SSH, cost ledger, agent and connection views.
- Independent Fastify backend under `server/src`.
- MySQL table browse, row insert/update/delete and arbitrary SQL console.
- S3-compatible bucket/object browse, metadata inspection, upload with HTTP metadata, download and delete.
- Multi-pane SSH terminal workspace over WebSocket.
- Manual monthly expense ledger with summaries.
- Agent gateway with persisted approval queue and a separate Pi worker execution API.
- Encrypted connection secrets, session auth, legacy admin-token auth and audit log persistence.
- HMAC-signed audit hash chain with an integrity status endpoint.
- Runtime backup export/restore for encrypted local state.

## Run Locally

```sh
npm install
npm run dev
```

Default URLs:

- Web: `http://localhost:5173` or the next free Vite port.
- API: `http://127.0.0.1:8787`
- Development token: `dev-admin-token`
- Development login: `admin` / `dev-admin-password`
- Development agent worker token: `dev-agent-worker-token`
- Optional operator label: enter it in the header bar or send `x-ops-actor` for audit attribution.

If Vite dev server is unstable in the local shell, build once and run the production preview with the API:

```sh
npm run build
npm run serve:local
```

Preview URLs:

- Web: `http://127.0.0.1:4173`
- API: `http://127.0.0.1:8787`

## Production Environment

Set these before running the API in production:

```sh
OPS_ADMIN_TOKEN="replace-with-at-least-32-char-random-token"
OPS_AGENT_WORKER_TOKEN="replace-with-a-different-32-char-random-token"
OPS_BOOTSTRAP_ADMIN_USER="admin"
OPS_BOOTSTRAP_ADMIN_PASSWORD="Replace-With-Strong-Key-2026!"
OPS_SESSION_TTL_MS="43200000"
OPS_SESSION_IDLE_TIMEOUT_MS="1800000"
OPS_AUTH_MAX_FAILED_LOGINS="5"
OPS_AUTH_LOCKOUT_MS="900000"
OPS_AGENT_WORKER_ID="pi-ops-01"
OPS_AGENT_WORKER_EXECUTE="false"
OPS_AGENT_WORKER_ALLOW_COMMANDS="hostnamectl,uptime,systemctl,df"
OPS_AGENT_WORKER_CWD="/"
OPS_AGENT_WORKER_POLL_MS="5000"
OPS_AGENT_WORKER_COMMAND_TIMEOUT_MS="60000"
OPS_AGENT_WORKER_MAX_OUTPUT_BYTES="200000"
OPS_SECRET_KEY="replace-with-at-least-32-bytes"
OPS_DATA_DIR="/var/lib/gang-chat-admin"
OPS_CORS_ORIGIN="https://ops.example.com"
OPS_ALLOW_INSECURE_CORS_ORIGIN="false"
OPS_HOST="127.0.0.1"
OPS_PORT="8787"
OPS_BODY_LIMIT_BYTES="20971520"
OPS_UPLOAD_LIMIT_BYTES="104857600"
OPS_RATE_LIMIT_MAX="600"
OPS_RATE_LIMIT_WINDOW="1 minute"
OPS_TRUST_PROXY="false"
OPS_SSH_MAX_SESSIONS="12"
OPS_SSH_IDLE_TIMEOUT_MS="600000"
OPS_SSH_READY_TIMEOUT_MS="15000"
OPS_SSH_KEEPALIVE_INTERVAL_MS="20000"
OPS_SSH_TICKET_TTL_MS="30000"
OPS_SSH_REQUIRE_HOST_KEY_VERIFICATION="true"
NODE_ENV="production"
```

`OPS_SECRET_KEY` encrypts stored connection credentials. Losing it means stored secrets cannot be decrypted.
Production `OPS_ADMIN_TOKEN` and `OPS_AGENT_WORKER_TOKEN` must each be at least 32 characters.
`OPS_AGENT_WORKER_TOKEN` must be different from `OPS_ADMIN_TOKEN`; it is only for the Pi worker process.
`OPS_BOOTSTRAP_ADMIN_USER` and `OPS_BOOTSTRAP_ADMIN_PASSWORD` create the first local admin user only when the auth store has no users. Production bootstrap passwords must be at least 14 characters and include lowercase, uppercase, number and symbol characters. Remove or rotate the bootstrap password after the first successful login. Existing `OPS_ADMIN_TOKEN` bearer auth remains supported for scripts and emergency access.
Local users have one of three roles: `viewer` can read operational data, `operator` can run daily operational writes such as MySQL/S3 mutations, SSH tickets, expenses and agent approvals, and `admin` can manage connection presets, users, backups and audit logs. `OPS_ADMIN_TOKEN` always authenticates as `admin`.
Operators can change their password from the `Connections` view. Password changes can revoke other active sessions, and individual sessions can also be revoked from the same view.
Sessions have both an absolute lifetime (`OPS_SESSION_TTL_MS`) and an idle timeout (`OPS_SESSION_IDLE_TIMEOUT_MS`). Active requests refresh the idle window, but no session can outlive its absolute expiry.
Failed username/password logins are audited. `OPS_AUTH_MAX_FAILED_LOGINS` and `OPS_AUTH_LOCKOUT_MS` control account lockout after repeated failures.
`OPS_SSH_REQUIRE_HOST_KEY_VERIFICATION` defaults to `true` in production and `false` in development. When enabled, every SSH preset must include the server host key SHA256 fingerprint before a terminal ticket can be issued.
Production `OPS_CORS_ORIGIN` is required, cannot be `*`, and must use HTTPS unless `OPS_ALLOW_INSECURE_CORS_ORIGIN=true` is explicitly set for a private TLS-terminated deployment. Browser requests with an `Origin` outside the allowlist are rejected before authentication.

## Pi Agent Worker API

The browser never receives the worker token. Run the Pi worker as a separate constrained process. It defaults to dry-run mode, so approved jobs are claimed and reported without executing commands:

```sh
OPS_API_BASE="http://127.0.0.1:8787" \
OPS_AGENT_WORKER_TOKEN="dev-agent-worker-token" \
OPS_AGENT_WORKER_ID="pi-local" \
npm run agent:worker
```

Set `OPS_AGENT_WORKER_EXECUTE=true` only on the controlled machine that should run approved commands. Real execution also requires `OPS_AGENT_WORKER_ALLOW_COMMANDS`, a comma-separated executable allowlist such as `hostnamectl,uptime,systemctl,df`. Commands that use shell chaining, pipes, redirection, command substitution or control characters are rejected before execution. Set `OPS_AGENT_WORKER_CWD` to pin the worker process working directory if needed. The worker enforces `OPS_AGENT_WORKER_COMMAND_TIMEOUT_MS` and truncates stdout/stderr at `OPS_AGENT_WORKER_MAX_OUTPUT_BYTES`.

The worker calls these endpoints with `Authorization: Bearer $OPS_AGENT_WORKER_TOKEN`:

```sh
GET  /api/agent/worker/jobs?limit=10
POST /api/agent/worker/jobs/:id/start     # { "workerId": "pi-worker-01" }
POST /api/agent/worker/jobs/:id/complete  # { "workerId": "pi-worker-01", "result": "...", "commandResults": [] }
POST /api/agent/worker/jobs/:id/fail      # { "workerId": "pi-worker-01", "error": "..." }
```

Only operator-approved jobs are exposed to the worker queue. Operators can edit the final command list before approval; the worker receives the approved command list, not a hidden browser-side draft. The main API stores execution state and audit events, but it does not execute shell commands itself.

## Backup And Restore

Use the `Connections` view to export a runtime backup JSON or restore one. Backups include:

- connection presets with encrypted secrets
- audit events
- expense ledger entries
- agent approval jobs
- local admin users and active sessions

The restore flow validates and previews the backup first, showing current versus incoming store counts before the destructive `RESTORE` confirmation is accepted. Restoring a backup overwrites those runtime stores. The same `OPS_SECRET_KEY` is required to decrypt restored connection secrets and validate existing session token hashes. Session bearer tokens are never exported in plaintext; only HMAC hashes are stored.
Runtime JSON stores are protected by per-file lock directories, written through temporary files, fsynced before replacement and backed up to a sibling `.bak` file before each committed overwrite or restore. The lock prevents concurrent writers from separate Node processes from overwriting each other; stale locks are automatically reclaimed.

## Audit Integrity

Every new audit event is signed with an HMAC derived from `OPS_SECRET_KEY` and linked to the previous signed event hash. The `Connections` view displays the integrity summary from `GET /api/audit/integrity`, including signed, unsigned and broken-chain counts. Existing legacy events without hashes are kept readable and reported as unsigned.
Use the Audit `Export` action to download all retained audit events with the current checkpoint (`headHash`, total, signed, unsigned and validity). Store those exports outside the runtime volume if you need an external tamper-evidence trail.

## Scripts

```sh
npm run dev        # API + frontend
npm run dev:api    # API only
npm run dev:web    # frontend only
npm run agent:worker # Pi/local agent worker, dry-run unless explicitly enabled
npm run serve:local # API + production preview
npm run check      # Svelte/front-end type checks
npm run check:api  # backend TypeScript check
npm run test:api   # backend tests
npm run lint       # Prettier + ESLint
npm run build      # frontend build + API bundle
npm run start:web  # run adapter-node frontend build
npm run start:api  # run bundled API
```

## Container Run

Build and run the production web/API services with Docker Compose:

```sh
OPS_ADMIN_TOKEN="replace-with-at-least-32-char-random-token" \
OPS_AGENT_WORKER_TOKEN="replace-with-a-different-32-char-random-token" \
OPS_SECRET_KEY="replace-with-at-least-32-bytes" \
docker compose up --build
```

Compose URLs:

- Web: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:8787`

The API service stores encrypted runtime state in the `ops-data` volume.
Persist the volume and include both `*.json` and `*.json.bak` files in host-level backups.

## Security Notes

- Do not expose the API without TLS and a real `OPS_ADMIN_TOKEN`.
- Set `OPS_CORS_ORIGIN` to the exact browser origin of the ops UI; do not use wildcard origins.
- Use at least 32 random characters for production admin and worker bearer tokens.
- Keep `OPS_AGENT_WORKER_TOKEN` separate from the browser and admin token.
- Prefer username/password login for operators. Treat `OPS_ADMIN_TOKEN` as an emergency/script secret and keep it out of browsers when possible.
- Assign the lowest practical role. Give `admin` only to users who need preset, user, backup or audit administration.
- `x-ops-actor` is an audit label override, not an authentication boundary.
- Use a unique `OPS_SECRET_KEY` per deployment.
- Local admin passwords must satisfy the backend password policy: 14+ characters with lowercase, uppercase, number and symbol characters, and without the username.
- Remove `OPS_BOOTSTRAP_ADMIN_PASSWORD` after the first admin user exists, or replace it with a secret manager value for controlled recovery.
- Revoke stale sessions after operator changes or incident response.
- Keep session idle timeout short enough for shared operation workstations, and keep absolute session lifetime bounded even for active operators.
- Tune account lockout with `OPS_AUTH_MAX_FAILED_LOGINS` and `OPS_AUTH_LOCKOUT_MS`; monitor failed `auth.login` audit events.
- Treat audit hash-chain validation as local tamper evidence. Export backups regularly if you need an external checkpoint of the latest audit head hash.
- Keep rate limiting enabled; tune `OPS_RATE_LIMIT_MAX` and `OPS_RATE_LIMIT_WINDOW` per deployment.
- Do not intentionally run multiple API replicas against the same JSON data directory unless the storage backend preserves atomic directory creation and rename semantics. For horizontally scaled deployments, move runtime state to a database.
- Set `OPS_TRUST_PROXY=true` only behind a trusted reverse proxy that forwards client IPs correctly.
- SSH WebSocket sessions are capped by `OPS_SSH_MAX_SESSIONS`, use short-lived tickets, are visible in the terminal workspace, can be force-closed with exact session-id confirmation, and close after `OPS_SSH_IDLE_TIMEOUT_MS` without activity.
- Pin SSH host keys in each SSH preset. You can get the OpenSSH SHA256 fingerprint with `ssh-keyscan host.example.com | ssh-keygen -lf -`.
- Run the Pi agent worker as a separate constrained process.
- Keep command execution approval-gated; only approved jobs appear in the worker API. The browser never receives the worker token, and the worker still applies its own command allowlist before running anything.
- Destructive operations require explicit confirmations at the API boundary:
  MySQL mutation SQL requires `RUN MUTATION`, MySQL row delete requires the table name, S3 delete requires the exact object key, expense delete requires the entry id, and connection preset delete requires the preset id.
- MySQL row update/delete require the submitted row key to exactly match a primary key or unique index. The API pre-checks that the key matches exactly one row before mutating.
- MySQL presets default to read-only. Row insert/update/delete and mutation SQL require the preset `allow writes` flag before the existing mutation confirmations are evaluated.
- S3 uploads default to no-overwrite. Existing objects can only be overwritten when overwrite mode is enabled and the exact object key is confirmed.
- S3 presets default to read-only. Object upload, overwrite and delete require the preset `allow writes` flag before overwrite/delete confirmations are evaluated.
- S3 uploads stream through the API to object storage; files are not buffered fully in memory by the application process.
- S3 uploads can set `Content-Type`, `Cache-Control`, `Content-Disposition` and custom metadata JSON. Custom metadata keys are bounded, must be raw names without `x-amz-*` prefixes, and values must be strings.
- S3 object keys reject leading slashes, control characters and `..` path segments before storage adapters run. Object detail uses HEAD metadata before destructive actions.
- MySQL SQL console is intentionally powerful. Restrict database users per preset.
- Prefer per-environment read/write credentials instead of global cloud or database admins.
