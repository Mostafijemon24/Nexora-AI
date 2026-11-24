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
  it. A native install is known by a registration id it generates and keeps in the OS secure store;
  it is sent only to this server and never shown. A device that presents its own identity again
  (with the license key, or by signing in) gets its seat back with a new session, and the earlier
  session on that seat ends — so a lost session does not need a transfer, and one seat never
  carries two sessions. Any other device is answered `in_use`.
- **Transfer** emails a 6-digit code to the license owner. The code is stored as a keyed hash, bound
  to the requesting device, valid 10 minutes, dead after 5 wrong guesses, and single use. Confirming
  it deactivates one device and registers the new one atomically: on a license with several seats,
  the device named in `replaceDeviceId` (the `in_use` answer lists them), or else the one that has
  gone longest without checking in.
- **Plans.** `subscription_plans.features` lists what a plan adds to the base product: `workflows`,
  `integrations`, `desktop`, `team`, `workspaces`. A request for something the plan lacks is
  answered `402 not_included`; a native activation on a plan without `desktop` is refused with
  `not_included`. A `lifetime` license never expires.
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

Errors are `{ "code", "message" }`. `401 license_required` means the device must (re)activate;
`401 sign_in_required` that it has its seat but nobody is signed in; `403 mfa_setup_required` that
the workspace requires two-step sign-in; `403 forbidden` that the caller's role does not allow it;
`402 not_included` that the plan does not include it.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/v1/license/status` | `{device}` → `{license \| null, entitlementToken?, events[]}` |
| POST | `/v1/license/activate` | `{key, device}` → `{ok:true, license, entitlementToken, sessionToken?, signInRequired?}` or `{ok:false, code}` (`invalid`, `expired`, `revoked`, `in_use` with `devices[]`, `not_included`). Browsers get cookies; native gets `sessionToken`. |
| POST | `/v1/license/transfer/request` | `{key, device}` → 204 always (does not reveal whether the key exists) |
| POST | `/v1/license/transfer/confirm` | `{key, code, device, replaceDeviceId?}` → as activate, or `{ok:false, code:"bad_code"}` |
| POST | `/v1/license/deactivate` | releases this device's seat |
| POST | `/v1/auth/sign-in` | `{email, password, code?, device}` → as activate, or `bad_credentials`, `mfa_required`, `bad_code`, `no_workspace`. Takes a free seat of the license that covers the person's workspace. |
| POST | `/v1/auth/password/forgot` · `/reset` | `{email}` → 204 always · `{email, code, password}` |
| POST | `/v1/auth/invite/info` · `/accept` | `{token}` → who it is for · `{token, name, password, device}` → as sign-in |
| POST | `/v1/auth/sign-out` · `/password` | signed in: end the sign-in on this device · set or change the password |
| POST | `/v1/auth/mfa/setup` · `/enable` · `/disable` | TOTP secret and `otpauth://` address · `{code}` → `{recoveryCodes}` · `{password, code}` |
| POST / DELETE | `/v1/team/invitations` · `/v1/team/invitations/:id` | admin: invite `{email, role}` · cancel |
| POST / DELETE | `/v1/team/members/:id/role` · `/v1/team/members/:id` | admin: change a role · remove a member (their sessions end, their seats are freed) |
| POST | `/v1/workspaces` · `/v1/workspaces/switch` | owner: add a workspace · point this session at another one |
| GET | `/v1/workspace` | the full snapshot (`WorkspaceSnapshot` in `../src/lib/types.ts`) |
| GET | `/v1/workspace/metrics?range=7d\|30d\|90d` | replies per bucket and the lead funnel, computed from stored data |
| POST | `/v1/workspace/changes` | one `Change`; its `id` is the idempotency key. 204, or `{effects:true}` when the write set more in motion (a workflow ran, a reply was delivered) and the client should reload |
| POST | `/v1/leads/import` | `{csv}` (header row with `name`, `company`; optional `title`, `industry`, `size`, `country`, `email`, `phone`, `linkedin`, `tags`, `stage`) → `{imported, skipped, leads}` |
| POST | `/v1/ai/chat` · `/v1/ai/posts/generate` · `/v1/ai/leads/:id/draft` | AI gateway; `notice` is set when a fallback model answered |
| POST | `/v1/ai/providers/verify` | admin: `{name, key}` → `{verified}`; an empty key re-checks the stored one |
| GET | `/v1/ai/openrouter/models` | live list from OpenRouter |
| POST | `/v1/integrations/:id/connect` | admin: `{apiKey}` or `{fields}`; OAuth returns `{redirectUrl}`; some return `{details}` to copy into the other system, shown once |
| GET | `/v1/integrations/:id/callback` | OAuth redirect target |
| POST / DELETE | `/v1/integrations/:id/test` · `/sync` · `/v1/integrations/:id` | test · sync now · disconnect |
| POST | `/v1/posts/:id/publish` | publishes an approved post to LinkedIn → `{url}` |
| GET / POST | `/v1/hooks/wa/:token` | WhatsApp: Meta's verification, and deliveries signed with the connection's app secret |
| POST | `/v1/hooks/in/:token` | generic incoming message: `{channel?, from, name?, text, subject?, id?}` |
| GET / POST | `/v1/backups` · `/v1/backups/:id` | admin: list, create, download |
| POST | `/v1/backups/:id/restore` · `/v1/backups/restore` | admin: restore a stored backup · `{backup}` restores a downloaded file |
| DELETE | `/v1/sessions/:id` | admin: revoke another session in this workspace |
| GET | `/healthz` | database check |

`Change` entities: `lead`, `campaign`, `post`, `prompt`, `task`, `workflow` (upsert/delete),
`conversation`, `message` (a reply to deliver), `run` (start, approve or reject), `activity`
(upsert), and the singletons `profile`, `icp`, `routing`, `openrouter`, `sync`, `security`,
`publishing`. Server-side rules: a write can only touch rows of the caller's workspace; viewers
cannot write; workspace settings need an admin; a workflow must pass `workflowProblem`
(`../src/lib/workflow.ts`); messages on a conversation are merged, never replaced; a reply is
delivered once per message id.

## Roles

`owner` (the license holder: everything, including other workspaces), `admin` (team, integrations,
keys, settings, backups, other people's sessions), `member` (leads, posts, conversations, workflows,
AI), `viewer` (reads only). The role is read from `workspace_members` on every request, so a change
takes effect on the member's next request.

## Workflows

`../src/lib/workflow.ts` defines every step kind and runs them; the server (`src/workspace/automation.ts`)
and the app's local mode both use it. Events come from committed writes, lead import, CRM sync and
incoming messages. `src/background.ts` runs once a minute (in the worker with Redis, in the API
process without): due delays and schedules, mailboxes, CRM and calendar sync, scheduled LinkedIn
posts, and the daily backup.

## Messaging and sync

- **Email**: a workspace connects its own mailbox (SMTP to send, IMAP to receive). New mail is read
  once a minute, from the moment of connecting onwards, read-only.
- **WhatsApp**: Cloud API with the workspace's own number. Connecting returns the callback address
  and verify token to enter at Meta. Deliveries without a valid `X-Hub-Signature-256` are refused.
- **HubSpot, Salesforce** (`src/sync/leads.ts`): matched by the CRM's id or by email; one-sided
  changes are copied; when both sides changed the workspace's conflict rule decides; an empty CRM
  value never erases a value here; a lead written by a sync is not sent straight back.
- **Google Calendar**: open tasks with a due date become all-day events; moving the event moves the task.
- **LinkedIn**: `POST /rest/posts` as the signed-in member, once per post.
- **Outgoing webhooks** carry `X-Nexora-Timestamp` and `X-Nexora-Signature`
  (`sha256=` HMAC of `"<timestamp>.<body>"`) when the connection has a signing secret, and only go
  to public https addresses.

## AI gateway

Bring-your-own-key. A key is sent once, verified against the provider, stored AES-256-GCM encrypted
and never returned. Each task (content, lead research, replies) is routed to the provider chosen in
Settings. Every call writes a `usage_records` row.

- **OpenRouter**: the model list, context sizes and prices are read live on every request; nothing is
  assumed to stay free. The workspace's default model is used; if it fails with rate limit, no
  credits, unavailable or outage **and** a fallback is configured, the fallback answers that one call
  and the response says so. The default is never changed. Spend is capped by the monthly limit using
  the cost OpenRouter reports.
- **Anthropic Claude** is called through the official SDK (`claude-opus-5-5` by default, with the API's
  server-side refusal fallback enabled). OpenAI and Gemini default models are set by `OPENAI_MODEL`
  and `GEMINI_MODEL`.
- Cost is what the provider reports (OpenRouter), or the tokens used at the model's price in
  `src/ai/pricing.ts`. Add or correct prices with `AI_PRICES`; a model with no price is recorded
  without a cost and shown as "not priced".
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
- Passwords are hashed with scrypt; a reset code or invitation is stored only as a keyed hash; a
  TOTP secret is encrypted and each code is accepted once.
- Rate limits: activation, transfer requests and confirmations, sign-in (per address and per
  account), password resets, invitations, incoming webhooks, and AI calls. Shared across
  instances with Redis, per process without it.
- Set `TRUST_PROXY=1` only behind a proxy you control; otherwise `X-Forwarded-For` is ignored.

## Known limits

See `../PROJECT_STATUS.md`.
