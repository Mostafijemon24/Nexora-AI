# Nexora AI — project status

_Last updated: 23 November 2026_

## Completed

**Client** (`src/`, `src-tauri/`, `crates/nexora-core/`)
- License gate and seven modules (Dashboard, AI Intelligence, Content Studio, Communication,
  Automation, Integrations, Settings) in one React + TypeScript UI; light/dark; sidebar and Android
  bottom navigation.
- Tauri 2 shell with typed commands; Rust core for the SQLite offline queue, local cache and
  offline verification of signed entitlement tokens; OS keystore for secrets on desktop.
- HTTP client for the real API, and a local backend for running without a server: the workspace starts
  empty and is kept in the device's storage; integrations and provider keys cannot be connected and say so,
  and AI answers are built-in examples.
  `?sample` loads the sample workspace instead.
- A tour for every page, shown the first time the page is opened and from the header's ? button.

**Backend** (`backend/`)
- License server: activation, one active device per license (configurable per plan or license),
  email-verified transfer, deactivation, expiry, revocation, renewal, audit log, signed offline
  entitlement tokens. Data model: `licenses`, `license_activations`, `license_devices`,
  `license_entitlements`, `license_events`, `subscriptions`, `subscription_plans`, `usage_records`.
- Per-request license enforcement on every protected route; workspace isolation on every query.
- Workspace API: snapshot, computed dashboard metrics, validated idempotent writes, backups,
  session revocation.
- AI gateway: OpenAI, Google Gemini, Anthropic Claude and OpenRouter with bring-your-own keys
  encrypted at rest, per-task routing, usage records, OpenRouter live model list, configured
  fallback and monthly spend limit.
- Integrations: key-based and OAuth (authorization-code) connections with encrypted credentials.
- BullMQ worker for email and housekeeping (optional; the API does both itself without Redis).
- Operator CLI: key generation, migrations, license create/revoke/renew, CSV lead import.
- Lead import from CSV inside the app (Integrations → Manual, user-controlled).
- OAuth access tokens are refreshed with the stored refresh token when they expire.

**Delivery**
- `backend/Dockerfile` for the API, worker and migrations.
- GitHub Actions: `ci.yml` runs every test suite on each push; `release.yml` builds Windows, macOS
  and Linux installers into a draft release.

## Verification evidence

| Check | Result |
| --- | --- |
| Backend tests (`backend`, `npm test`, real PostgreSQL 16 and Redis) | 59 passed |
| Client unit tests (`npm test`) | 18 passed |
| Rust tests (`cargo test --workspace`) | 18 passed, including the server-token contract test |
| Browser run against the real API (web) | 20 checks passed: activation, httpOnly cookies, persistence across reload, same-device second tab, second-device rejection, transfer by emailed code, old device locked out, deactivation |
| Desktop app (Linux build) run against the real API | activated with a real key; session, device id and entitlement token stored in the OS keyring; relaunch opened straight into the workspace; with the API stopped it started offline on the signed token and cached data |
| Browser run in demo mode | 50 checks passed across every screen and platform frame (before the workspace started empty) |
| Browser run of the empty workspace and the page tours | all 30 tour steps on desktop and phone widths, empty state of every page, data and tour state kept across a restart |
| Typecheck and production build (client), typecheck (backend), Tauri shell compile (Linux) | pass |

What the license tests cover: first activation; second device rejected; 12 simultaneous activations
admit exactly one; the database constraint alone refuses a duplicate seat; one browser with several
tabs is one device; cookies replayed from another browser are refused; deactivation and transfer;
wrong, expired, exhausted and wrong-device transfer codes; expired and revoked licenses; offline
token contents, grace period and expiry cap; a copied device id is not accepted; every protected
route returns 401 without a license; cross-workspace reads and writes are refused.

## Not verified

- **No provider was called with a real key.** The OpenAI, Gemini and OpenRouter adapters and the four
  OAuth configurations (LinkedIn, HubSpot, Salesforce, Google Calendar) are written from the
  providers' documented request shapes and tested against scripted responses only. Check each one
  with a real account before relying on it, and confirm the default model names in `.env`.
- No Windows, macOS or Android build has been made or run; only the Linux desktop app was. The
  release workflow and the Dockerfile are written but have not been run.
- Email was exercised through the queue and a capture mailer, not through a real SMTP server.

## Outstanding

- **Sign-in and team members.** A license on a device is the only credential; there are no
  passwords, roles or invitations. The MFA switch in Settings is stored but enforces nothing.
- **Billing.** Plans and subscriptions exist as data; nothing charges a card. Licenses are issued,
  renewed and revoked with the CLI. A payment-provider webhook should call the same functions.
- **Message delivery.** A reply sent in Communication is stored; it is not delivered to email,
  WhatsApp or any other channel, and nothing imports inbound messages.
- **Workflow execution.** Workflows and test runs are stored and rate-limited; no engine executes
  their steps on triggers.
- **Integration sync.** Connections are stored and testable; no data is synced with HubSpot,
  Salesforce, Google Calendar or LinkedIn.
- **Self-hosted endpoint and cloud region.** Saved as settings; the client always talks to
  `VITE_API_URL` and no data is moved between regions.
- **Backups.** A backup stores a snapshot row; there is no restore or download.
- **Android** project initialisation and secure storage, **auto-update**, code signing.

## Known limitations

- A transfer on a multi-device license deactivates all of its devices, not one chosen device.
- A native install that loses its session token (for example a wiped keystore) while its seat is
  still active must use the transfer flow to get back in.
- Sessions list shows device and last-seen time only; there is no location lookup.
- AI cost is reported only for OpenRouter; other providers are counted in tokens.
- Rate limits are per process unless Redis is configured.
- The backend imports the lead-scoring module and shared types from the client's `src/lib`, so it
  must be deployed from this repository layout.
