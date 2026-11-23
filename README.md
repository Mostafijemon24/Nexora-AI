# Nexora AI

AI-powered LinkedIn growth and lead-intelligence workspace. One React + TypeScript UI, shipped
as a web app and, through a Tauri 2 (Rust) shell, on Windows, macOS, Linux and Android.

Implemented from the Claude Design handoff in `design/`.

## Run

```bash
npm install
npm run dev            # web, http://localhost:1420
npm run tauri dev      # desktop shell (needs the Tauri 2 system prerequisites)
npm run build          # typecheck + production web build → dist/
npm test               # UI logic tests (vitest)
cargo test --workspace # Rust core + shell tests
```

Without `VITE_API_URL` the app runs on an **in-memory demo backend** (`src/api/demo.ts`) so the UI
can be reviewed without a server. Demo license keys, one per server outcome:

| Key | Outcome |
| --- | --- |
| `NXR-VALID-0001` | activates |
| `NXR-EXPIRED-0002` | expired |
| `NXR-REVOKED-0003` | revoked |
| `NXR-INUSE-0004` | in use on another device → transfer with any 6-digit code |
| `NXR-OFFLINE-0005` | license server unavailable |

In a browser, `?platform=windows|macos|linux|android|web` previews that target's frame and
navigation with drawn window chrome. It works in dev and demo builds only; real builds use the
browser's own chrome or the OS's native window decorations.

## Layout

```
src/
  lib/         domain types, lead scoring, dates, post status flow (+ tests)
  api/         Backend interface · http.ts (production) · demo.ts (development)
  platform/    bridge.ts — the only door to the OS (typed Tauri commands, web fallback)
  state/       store.ts — app state, offline queue handling, license boot flow
  components/  Card, buttons, Seg, Switch, Dialog, Toast
  shell/       sidebar, header, Android bottom bar, preview chrome
  screens/     LicenseGate, Dashboard, AiIntelligence, ContentStudio, Communication,
               Automation, Integrations, Settings
  styles/      industry.css (design system, verbatim) · app.css (app layer)
crates/nexora-core/   Rust: entitlement-token verification, SQLite offline queue + cache
backend/              API, license server, AI gateway (see backend/README.md)
src-tauri/            Rust: Tauri 2 shell, typed commands, OS secure store
```

## Rules the code enforces

- **License**: the app is gated until the server reports an active license for this device. The
  client never validates a key. Native targets store the server's Ed25519-signed entitlement
  token and verify signature, device binding, license expiry and a 7-day grace period offline
  (`nexora-core::entitlement`); web revalidates every session.
- **Offline (native only)**: writes apply locally, go into a SQLite queue and are replayed in
  order on reconnect. Every change carries an idempotency key (`Change.id`), stored `UNIQUE`,
  and is sent as the `Idempotency-Key` header. AI, connection tests, connect/disconnect, key
  verification, session revocation, deactivation and backup are blocked offline with a message.
- **Secrets**: provider keys are sent to the server once and never read back. The session token,
  entitlement token and device id live in the OS keystore; the UI can only reach `session`.
- **No silent failures**: validation shows inline; every destructive action confirms in a dialog.

## Production configuration

| Setting | Where | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | build env (`.env`) | Backend base URL. Disables the demo backend and platform preview. |
| `NEXORA_LICENSE_PUBLIC_KEY` | build env for `cargo`/`tauri build` | Base64 of the license server's 32-byte Ed25519 public key. Without it no offline token verifies. |

### API contract (`src/api/http.ts`)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/v1/license/status` | `{device}` → `{license \| null, entitlementToken?, events[]}` |
| POST | `/v1/license/activate` | `{key, device}` → `{ok:true, license, entitlementToken, sessionToken?}` or `{ok:false, code}` with `invalid \| expired \| revoked \| in_use` |
| POST | `/v1/license/transfer/request` · `/confirm` | emails a 6-digit code · `{key, code, device}` |
| POST | `/v1/license/deactivate` | `{device}` |
| GET | `/v1/workspace` | full `WorkspaceSnapshot` (`src/lib/types.ts`) |
| GET | `/v1/workspace/metrics?range=7d\|30d\|90d` | replies bars + funnel |
| POST | `/v1/workspace/changes` | one `Change`; must be idempotent on `Idempotency-Key` |
| POST | `/v1/ai/chat` · `/v1/ai/posts/generate` · `/v1/ai/leads/:id/draft` | AI gateway |
| POST | `/v1/ai/providers/verify` | `{name, key}`; empty key re-checks the stored one |
| GET | `/v1/ai/openrouter/models` | live model list, price, availability |
| POST/DELETE | `/v1/integrations/:id/test` · `/connect` · `/:id` | connect returns `{redirectUrl}` for OAuth |
| POST | `/v1/backups` | → `{completedAt}` |
| DELETE | `/v1/sessions/:id` | revoke a session |

The entitlement token is `base64url(payload JSON).base64url(Ed25519 signature)` with payload
`{license_id, device_id, plan, issued_at, license_expires_at}` (Unix seconds).

## Backend

`backend/` holds the API, license server and AI gateway (Node, PostgreSQL, optional Redis). See
`backend/README.md` to run it, and `PROJECT_STATUS.md` for what is finished, what was verified and
what is still open.
