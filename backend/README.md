# Nexora AI backend

The API, license server and AI gateway behind the Nexora AI client. Node 22 (TypeScript run
directly, no build step), Hono, PostgreSQL, and optionally Redis + BullMQ.

## Run

```bash
docker compose up -d                 # Postgres 16 + Redis 7 (or point DATABASE_URL at your own)
npm install
npm run cli -- keygen                # prints the three secrets for .env and the client's public key
cp .env.example .env                 # paste the secrets in
npm run migrate
npm run cli -- license:create --email you@example.com --name "Your Name" --workspace "Your Co" --demo
npm run dev                          # API on :8787
npm run worker                       # only when REDIS_URL is set
npm test                             # needs Postgres; Redis tests skip themselves if Redis is down
```

Point the client at it with `VITE_API_URL=http://localhost:8787` and build native clients with the
printed `NEXORA_LICENSE_PUBLIC_KEY`.

Tests use `postgres://nexora:nexora@localhost:5432/nexora_test` (override with `TEST_DATABASE_URL`)
and **drop and recreate its schema**; never point them at a database you care about.

## Deploy

`backend/Dockerfile` builds one image for the API, the worker and migrations; build it from the
repository root (the commands are at the top of the file). The app and the API must be served from
the same site over https, for example `app.example.com` and `api.example.com`.

## Operator commands (`npm run cli -- <command>`)

| Command | Effect |
| --- | --- |
| `keygen` | New `LICENSE_SIGNING_KEY`, `DATA_ENCRYPTION_KEY`, `HASH_SECRET` and the matching client public key |
| `migrate` | Apply `migrations/*.sql` once each |
| `license:create --email --name --workspace [--plan] [--months] [--max-devices] [--demo]` | Issue a license; the key is printed once and only its hash is stored |
| `license:revoke --key` | Revoke; every device is locked out on its next request |
| `license:renew --key [--months]` | Extend the license and its subscription period |
| `leads:import --workspace --file` | Import leads from CSV (`name,title,company,industry,size,country`) |

## Layout

```
migrations/001_init.sql   schema
src/license/service.ts    activation, seats, transfer, deactivation, entitlement tokens, admin operations
src/app.ts                routes, CORS/CSRF, per-request license enforcement
src/workspace/            snapshot + metrics (reads), changes (validated, idempotent writes)
src/ai/                   provider adapters (OpenAI, Gemini, Claude, OpenRouter) and the gateway
src/integrations.ts       catalogue, key and OAuth connections, connection tests
src/queue.ts, worker.ts   BullMQ jobs: email, hourly housekeeping
src/crypto.ts             HMAC hashing, AES-256-GCM, Ed25519 token signing
```

## How licensing works

There is no separate sign-in in the product design: **a license activated on a device is the
credential.** Activation creates a server-side session tied to one seat of that license.

- **One license, one device.** Every activation, transfer and deactivation of a license takes a row
  lock on it and runs in a transaction. Independently, a partial unique index
  (`license_id, slot WHERE deactivated_at IS NULL`) makes a second concurrent seat impossible at the
  database level. The limit is per plan (`subscription_plans.max_devices`, default 1) and can be
  raised per license with a `license_entitlements` row (`max_devices`).
- **Device identity is established by the server.** A browser gets an httpOnly device cookie this
  server issued, bound to a hash of its user agent — all tabs share it, another browser cannot reuse
  it. A native install sends a registration id, but that alone proves nothing: re-activating a seat
  that is already taken requires the session token issued to that seat. Otherwise the answer is
  `in_use` and the way through is a transfer.
- **Transfer** emails a 6-digit code to the license owner. The code is stored as a keyed hash, bound
  to the requesting device, valid 10 minutes, dead after 5 wrong guesses, and single use. Confirming
  it deactivates the old device and registers the new one atomically.
- **Enforcement is per request.** Every `/v1` route except the license endpoints re-checks session →
  activation → license (`active`, not expired). Revocation, expiry, transfer and deactivation take
  effect on the next request; nothing is cached.
- **Offline tokens.** Native clients receive an Ed25519-signed entitlement token
  (`base64url(payload).base64url(signature)`) bound to their registration id. The client verifies it
  with the public key only, for 7 days from issue and never past license expiry. A fresh one is issued
  on every status check. `test/fixtures/entitlement.json` is checked from both sides: the backend must
  still produce that exact token, and `crates/nexora-core/tests/contract.rs` must still accept it.
- **Audit.** `license_events` records issue, activation, every failed activation (including unknown
  keys), transfer requests, failed and successful transfers, deactivation, revocation and renewal.

## API

Errors are `{ "code", "message" }`. `401 license_required` means the device must (re)activate.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/v1/license/status` | `{device}` → `{license \| null, entitlementToken?, events[]}` |
| POST | `/v1/license/activate` | `{key, device}` → `{ok:true, license, entitlementToken, sessionToken?}` or `{ok:false, code}` (`invalid`, `expired`, `revoked`, `in_use`). Browsers get cookies; native gets `sessionToken`. |
| POST | `/v1/license/transfer/request` | `{key, device}` → 204 always (does not reveal whether the key exists) |
| POST | `/v1/license/transfer/confirm` | `{key, code, device}` → as activate, or `{ok:false, code:"bad_code"}` |
| POST | `/v1/license/deactivate` | releases this device's seat |
| GET | `/v1/workspace` | the full snapshot (`WorkspaceSnapshot` in `../src/lib/types.ts`) |
| GET | `/v1/workspace/metrics?range=7d\|30d\|90d` | replies per bucket and the lead funnel, computed from stored data |
| POST | `/v1/workspace/changes` | one `Change`; its `id` is the idempotency key |
| POST | `/v1/leads/import` | `{csv}` (header row with `name`, `company`; optional `title`, `industry`, `size`, `country`) → `{imported, skipped, leads}` |
| POST | `/v1/ai/chat` · `/v1/ai/posts/generate` · `/v1/ai/leads/:id/draft` | AI gateway; `notice` is set when a fallback model answered |
| POST | `/v1/ai/providers/verify` | `{name, key}` → `{verified}`; an empty key re-checks the stored one |
| GET | `/v1/ai/openrouter/models` | live list from OpenRouter |
| POST | `/v1/integrations/:id/connect` | key-based: `{apiKey}`; OAuth: returns `{redirectUrl}` |
| GET | `/v1/integrations/:id/callback` | OAuth redirect target |
| POST / DELETE | `/v1/integrations/:id/test` · `/v1/integrations/:id` | test · disconnect |
| POST | `/v1/backups` | stores a snapshot → `{completedAt}` |
| DELETE | `/v1/sessions/:id` | revoke another session in this workspace |
| GET | `/healthz` | database check |

`Change` entities: `post`, `prompt`, `task`, `workflow` (upsert/delete), `conversation`, `run`,
`activity` (upsert), and the singletons `profile`, `icp`, `routing`, `openrouter`, `sync`, `security`.
Server-side rules: a write can only touch rows of the caller's workspace; a workflow starts with one
trigger and uses only the permitted step types; a new run's status and step count are decided by the
server (an Approval step always pauses it) and count against the daily run limit.

## AI gateway

Bring-your-own-key. A key is sent once, verified against the provider, stored AES-256-GCM encrypted
and never returned. Each task (content, lead research, replies) is routed to the provider chosen in
Settings. Every call writes a `usage_records` row.

- **OpenRouter**: the model list, context sizes and prices are read live on every request; nothing is
  assumed to stay free. The workspace's default model is used; if it fails with rate limit, no
  credits, unavailable or outage **and** a fallback is configured, the fallback answers that one call
  and the response says so. The default is never changed. Spend is capped by the monthly limit using
  the cost OpenRouter reports.
- **Claude** is called through the official SDK (`claude-opus-5-5` by default, with the API's
  server-side refusal fallback enabled). OpenAI and Gemini default models are set by `OPENAI_MODEL`
  and `GEMINI_MODEL`.
- Cost is recorded only when the provider reports it (OpenRouter). For the others the month's
  estimate counts tokens but not dollars.
- Prompts instruct the model to use only supplied workspace data and never guess missing fields;
  unknown lead fields are passed as `null`.

## Security notes

- Secrets at rest: license keys, session tokens, transfer codes and OAuth states are stored only as
  HMAC-SHA256 hashes; provider keys and OAuth tokens are AES-256-GCM encrypted.
- Browsers never receive a session token in a response body; cookies are `HttpOnly`, `SameSite=Lax`,
  and `Secure` when `PUBLIC_API_URL` is https. The app and API must be same-site (for example
  `app.` and `api.` on one domain).
- CSRF: a write with a foreign `Origin` is refused; cookies are honoured on writes only from
  `APP_ORIGINS`. CORS allows those origins and the packaged Tauri origins.
- Rate limits: activation, transfer requests and confirmations, and AI calls. Shared across
  instances with Redis, per process without it.
- Set `TRUST_PROXY=1` only behind a proxy you control; otherwise `X-Forwarded-For` is ignored.

## Known limits

See `../PROJECT_STATUS.md`.
