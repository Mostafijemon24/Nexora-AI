# Nexora AI — project status

_Last updated: 24 November 2026_

What is left to do is in [ROADMAP.md](ROADMAP.md). This page records what exists and how each part
was checked, including what has **not** been checked.

## Built

**App** (`src/`, one React + TypeScript UI for the web, desktop and Android)
- First screen: activate with a license key, sign in, or join from an invitation; choose a server of your own.
- Nine pages: Dashboard, Leads, AI Intelligence, Content Studio, Communication, Automation, Reports,
  Integrations, Settings. Light and dark themes; sidebar on wide windows, bottom navigation on narrow ones.
- **Leads**: stages (New, Contacted, Interested, Converted, Lost), contact details, tags, notes; a
  searchable, filterable list with bulk actions; a pipeline; campaigns with their figures; CSV import and export.
- **Automation**: workflows built from typed steps with their own settings, test runs that change
  nothing, run history with a log per step, approve and reject.
- **Communication**: replies are sent by email or WhatsApp when the channel is connected, and each
  reply shows whether it was sent; new conversations; incoming messages appear by themselves.
- **Reports**: rates, stages, campaigns, messages by channel, runs, tasks, AI usage per provider; CSV export.
- **Settings**: profile, AI providers, password and two-step sign-in, sessions with their place,
  team and roles, workspaces, hosting, backups (download, restore), license, appearance.
- A tour for every page, and a local mode that runs without a server (data on the device,
  workflows run while the app is open, nothing is sent or connected, and the app says so).

**Server** (`backend/`, Node 22, PostgreSQL, optional Redis)
- License server: seats per license, email-verified transfer of one chosen device, deactivation,
  expiry, revocation, renewal, audit log, signed offline tokens; an install that lost its session
  gets its seat back with the key.
- Accounts: password (scrypt), sign-in that takes a free seat, password reset by emailed code,
  two-step sign-in (TOTP, recovery codes, can be required per workspace), invitations, roles
  (owner, admin, member, viewer) checked on every request, several workspaces per account.
- Plans: Starter, Professional, Business (monthly and annual), Lifetime desktop, Enterprise; what a
  plan does not include (workflows, integrations, the desktop app, team, workspaces) is refused.
- Workspace API: validated, idempotent writes; leads, campaigns, posts, conversations, workflows,
  runs, tasks; metrics; backups (list, download, restore, daily automatic backup).
- Workflow engine (shared with the app in `src/lib/workflow.ts`): runs on a new lead, a stage
  change, a received message, a post status or a schedule; conditions, waits, approvals, tasks,
  AI drafts, notifications, webhooks; a message is only sent after an approval step; a workflow is
  never started by its own change; a daily run limit.
- Messaging: email through the workspace's own SMTP account, WhatsApp through the Cloud API;
  incoming mail over IMAP, WhatsApp on a signed webhook, and a generic incoming address.
- Sync: HubSpot contacts and Salesforce leads both ways with a conflict rule; tasks with Google
  Calendar; publishing approved posts to LinkedIn, by button or on their scheduled day.
- AI gateway: OpenAI, Gemini, Claude, OpenRouter with the workspace's own keys; usage and cost per provider.
- Background work once a minute: workflow runs and schedules, mailboxes, sync, publishing, backups.

**Desktop and Android** (`src-tauri/`, `crates/`)
- Tauri 2 shell; Rust core for the offline queue, cache and token verification; secrets in the OS keystore.
- Android app with secrets in the Android Keystore; installer artwork; file saving and opening links.
- Automatic updates, active in builds that were given an updater key.

**Delivery**
- `deploy/`: one command installs the server on a VPS (API, worker, PostgreSQL, Redis, HTTPS) and updates it.
- GitHub Actions: `ci.yml` (all tests, and the real server image started end to end), `pages.yml`
  (the web app at https://linkdin.avonixai.com), `release.yml` (installers), `platforms.yml`
  (build and start the app on Windows, macOS, Linux and Android), `deploy-server.yml` (update the VPS over SSH when its secrets are set).

## How it was checked

| Check | Result |
| --- | --- |
| Server tests (`backend`, `npm test`, real PostgreSQL 16) | 100 passed |
| App unit tests (`npm test`) | 34 passed |
| Rust tests (`cargo test --workspace`) | pass, including the server-token contract test |
| Browser, app without a server | 15 checks: leads, bulk actions, campaign, pipeline, building and test-running a workflow, a workflow running by itself, inbox, reports and export, data kept across reload, phone layout |
| Browser, app against the real server | 11 checks: a server workflow tagging a new lead and the page updating by itself, approval, multi-field connection dialog, incoming-message address, the message appearing in the inbox linked to its lead |
| Browser, accounts against the real server | 15 checks: password, sign-out and sign-in, two-step sign-in with a QR code and recovery codes, invitation joined without a license key, member and viewer limits, a second workspace, backup download and restore, session place |
| Windows, macOS, Linux | built and started in CI; the app must load its UI, call into Rust and still be running after 15 seconds |
| Android | debug APK built and run on an emulator in CI: UI loaded, the Keystore stored, returned and deleted a secret |
| Server image | built in CI and started with PostgreSQL and Redis; health check, license creation |
| Live web app | https://linkdin.avonixai.com loads over https, on desktop and phone widths |
| Live server | https://nexora-api.avonixai.com: installed with `deploy/install.sh` on the VPS (AlmaLinux 9, cPanel Apache in front); health check over https, and the web app built for it reaches it from a browser at the site's address (a made-up license key is refused by the server) |

What the server tests cover, beyond the earlier license tests: sign-in limits per account, reset
codes (single use, five guesses), TOTP against the RFC 6238 vectors and replay refusal, each role's
limits, workspace separation, plan limits, seat transfer of one chosen device, backup restore from
another workspace's file without touching it, workflows (conditions, approval claimed once, delays,
schedules in their own time zone, loop protection, daily limit, failed steps), replies delivered
once, WhatsApp webhook signatures, incoming mail, CRM sync conflicts and echo, calendar sync, and
LinkedIn publishing claimed once.

## Not checked against the real thing

Everything below is written and tested against **scripted** servers. None has been run against
the live service, because that needs the owner's accounts:

- **AI providers** (OpenAI, Gemini, Claude, OpenRouter) — no real key was used.
- **LinkedIn** sign-in and publishing; **HubSpot**, **Salesforce**, **Google Calendar** sign-in and sync.
- **Email**: sending through a real SMTP server and reading a real IMAP mailbox. The IMAP reader
  (`backend/src/mailbox.ts`) has never talked to a mail server.
- **WhatsApp** Cloud API sending and its webhook.
- **The live server with a real license**: the install script ran on the VPS and the server
  answers, but nobody has yet activated the app there with the real key, so activation, sign-in
  and saving data on the live server are checked only on a test server so far.
- **A real update** of an installed desktop app, the release workflow's update files, and the
  Android release build's upload. No real phone was used.
- A desktop app pointed at a server by address (rather than built for it) was not tried on a real desktop.

## One-time steps for the owner

1. **Server**: done. Open https://linkdin.avonixai.com, activate with the license key the
   installer printed, then set your name and email (Settings → My profile) and a password
   (Settings → Security).
2. **Email**: put `SMTP_URL` and `MAIL_FROM` in `/opt/nexora/deploy/.env`, then run the installer again.
3. **Automatic updates**: on your own computer run
   `npm run tauri signer generate -- -w ~/.tauri/nexora-updater.key`; add the `.pub` contents as
   the repository variable `TAURI_UPDATER_PUBKEY` and the key as the secret
   `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if you set one). Keep the
   key: without it installed apps can no longer update.
4. **Android release**: create an upload keystore and add the secrets `ANDROID_KEYSTORE` (base64 of
   the `.jks`), `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`.
5. **Integrations**: for each service you want to offer, create its developer app and add
   `OAUTH_<NAME>_CLIENT_ID` and `OAUTH_<NAME>_CLIENT_SECRET` to the server's `.env`
   (`LINKEDIN`, `HUBSPOT`, `SALESFORCE`, `GOOGLE_CALENDAR`). The redirect address to register is
   `https://<api domain>/v1/integrations/<li|hs|sf|gc>/callback`.
