# Handoff: Nexora AI — cross-platform app (Rust / Tauri 2)

## Overview
Nexora AI is an AI-powered LinkedIn growth and lead-intelligence workspace. One application, one codebase, five targets: **Web, Windows, macOS, Linux, Android**. This bundle covers seven modules — Dashboard, AI Intelligence, Content Studio, Communication, Automation, Integrations, Settings — plus the license-activation gate.

## About the design files
`Nexora AI.dc.html` is a **design reference built in HTML** — a clickable prototype with mock data and simulated server responses. It is not production code. The task is to **recreate it in the target stack below**, not to ship the HTML.

Open the file in a browser. The header switcher changes platform frame (Web / Windows / macOS / Linux / Android) and theme. `support.js` and the `_ds/` folder must sit beside it.

## Fidelity
**High-fidelity.** Colors, type, spacing, states and copy are final. All data is mock.

## Target architecture
Decisions already made by the product owner: **Hybrid hosting** (cloud + optional self-hosted endpoint), **Hybrid desktop sync** (online + offline queue), all modules built together.

| Layer | Choice |
| --- | --- |
| Shell | **Tauri 2** (Rust). Desktop: Windows, macOS, Linux. Mobile: Android. |
| UI | One React + TypeScript app shared by every target and the web build |
| Rust core (`src-tauri`) | Local SQLite cache, offline change queue, sync client, OS keychain/Keystore credential storage, license entitlement token verification, auto-update (desktop) |
| Backend | Node/Next.js API, PostgreSQL, Redis + BullMQ workers |
| AI | Central AI gateway on the backend: OpenAI, Gemini, Claude, OpenRouter |

Rules for the Rust side:
- UI never talks to the OS directly; everything goes through typed Tauri commands.
- API keys and session tokens live in the OS secure store, never in SQLite or localStorage.
- License keys are validated **by the license server only**. The client stores a signed entitlement token and verifies its signature and expiry offline (7-day grace on native targets; web revalidates every session).
- Every queued offline change carries an idempotency key so replay cannot duplicate.
- Platform differences are confined to window chrome and navigation (below). No per-platform business logic.

Things the prototype only simulates and that need verifying before build: Tauri 2 Android plugin coverage for secure storage and updates, LinkedIn API scope approval, and app-store distribution rules for Android.

## Platform frames
| Platform | Chrome | Navigation |
| --- | --- | --- |
| Web | Browser tab + URL bar `app.nexora.ai/<screen>` | Left sidebar |
| Windows | 34px title bar, app name left, min/max/close right (44px wide each) | Left sidebar |
| macOS | 30px title bar, three 11px window controls left, title centred | Left sidebar |
| Linux | 36px title bar, title centred, three 22px bordered controls right | Left sidebar |
| Android | 28px status bar, content max-width 412px, single column | Bottom bar, 7 icon tabs, 52px tall, active tab has 2px top border |

Use native window decorations where the OS provides them; the drawn bars are placeholders for those.

## Shell
- **Sidebar**: 212px expanded, 54px collapsed (icons only), 150ms width transition. Brand mark: 22px accent square with "N", then "Nexora AI" (Barlow Condensed 600, 17px). Nav item: 8px padding, 18px icon, 14px label; active = tint background + divider border + accent-700 text. Inbox shows an unread count tag. Footer: workspace name, "Professional · Hybrid hosting".
- **Header**: sidebar toggle, screen title (h4), sync indicator (7px square + label), "Go offline / Go online" (native targets only), platform switcher (prototype-only), theme toggle.
- **Main**: 20px padding, scrolls independently.
- **Toast**: bottom-centre, inverted colors, 2.6s.
- **Dialog**: backdrop + blueprint-framed modal, Cancel / confirm. Used before every destructive action.

## Screens

### License activation (gate)
Shown before anything else when no license is active. Card max-width 540px, centred. Fields: license key. States returned by the server: valid, expired, revoked, in use on another device (offers "Transfer license to this device" → 6-digit email code → old device deactivated), server unavailable, invalid. One license = one active device. Button shows "Validating with license server…" while pending. The "Prototype test keys" row is prototype-only — remove it.

### Dashboard
Greeting + date; range switch (7 / 30 / 90 days) that drives every widget; Customize toggles widgets on/off. Widgets: 4 KPI cards (each navigates to its module), replies bar chart, lead funnel (New → Contacted → Interested → Converted), upcoming tasks (checkable), AI activity, recent activity, system health (API, workers, sync). Grid: `repeat(auto-fit, minmax(300px, 1fr))`, 20px gap; KPI row `minmax(170px, 1fr)`.

### AI Intelligence
Tabs: Lead scoring, AI assistant, Prompt library.
- **Lead scoring**: criteria form (industry, job titles, company size min/max, location) → ranked lead table → breakdown card. Weights: industry 25, title 25, size 20, location 20; total normalised to 100. **Confidence (0–10) is separate from score** and counts how many fields were actually available. Missing fields show "Not available — not guessed" and score nothing. Labels: ≥75 High, ≥50 Medium, else Low.
- **AI assistant**: chat, quick-prompt chips, Enter to send. Requires a connection.
- **Prompt library**: list with Use / Delete; add form requires title and text.

### Content Studio
Tabs: Generator, Posts, Calendar.
- **Generator**: topic (required), audience, tone (Direct / Story / Data) → editable hook, body, CTA, hashtags → Save as draft / Regenerate.
- **Posts**: status flow **Draft → In review → Approved → Scheduled → Published**; one action button per status; Delete confirms.
- **Calendar**: 7-day grid, posts move a day earlier/later. Implement as drag-and-drop in production.
- Publishing is a manual reminder unless an approved LinkedIn scope is connected.

### Communication
Conversation list (search; All / Unread / Important) and thread. Thread: intent + sentiment, Mark important, Create follow-up (adds a dashboard task), messages, AI suggested reply (must be explicitly used — never auto-sent), saved-reply chips, composer (Send disabled when empty), internal notes. Sources are manual import and approved connectors only; LinkedIn private inbox is not accessed.

### Automation
Workflow list with enable toggle; editor with editable name, numbered steps (type tag + editable label, removable except the trigger), "Add step" for Condition, Action, Delay, Approval, Notification, Update, Stop; Test run; run history. A run containing an Approval step stops at "Awaiting approval" until approved. No step type may perform an action LinkedIn does not permit. Loop protection and a daily run limit apply.

### Integrations
Strategy card (Approved API / Manual / Not included), category filter, card grid `minmax(240px, 1fr)`. Each card: category, status tag, name, description, Connect or Test connection + Disconnect. OAuth integrations redirect to the provider; key-based ones take a key in a dialog (required). Disconnect confirms.

### Settings
Left tab list, right panel: My profile (email validated), AI providers (task → provider routing; per-provider key, Test, Verified tag; OpenRouter model table with All / Free / Paid filter, default and fallback model, monthly budget — unlocked only after the key verifies), Security (MFA toggle with confirm on disable; session list with Revoke), Sync and hosting (cloud region, self-hosted endpoint, offline cache toggle, conflict rule: ask / most recent wins / cloud wins; Back up now), License (masked key, device, Deactivate, grace-period note, license event log), Appearance (theme, sidebar).

## Interactions and behavior
- **Offline (native only)**: writes succeed locally, increment a pending counter shown in the header, and toast "saved locally, will sync". AI, connection tests, connect and backup are blocked with a clear message. Going online syncs the queue and resets the counter.
- **Validation**: inline message under the field, in accent-700, 12px. No silent failures.
- **Destructive actions** always confirm in a dialog.
- **Motion**: screen enter 200ms fade + 6px rise; toggles and bars 150–250ms. Nothing else animates.
- **Responsive**: grids wrap via `auto-fit`; on Android every multi-column span collapses to one column.

## State
Per workspace, server-owned: leads, scoring criteria, prompts, posts, conversations + notes, workflows + runs, integrations, AI routing, license + events, sessions.
Per device, local: theme, sidebar state, offline queue, cached entities, entitlement token.
Every server entity carries `workspace_id`; authorization is enforced on the backend, not by hiding buttons.

## Design tokens (Industry design system)
- **Light**: bg `#f2f2f3`, surface `#e9e9ea`, text `#1d1f20`, accent `#5980a6`, divider = text at 16%.
- **Dark** (prototype override): bg `#16181a`, surface `#1f2225`, text `#e4e6e8`, accent `#749dc4`, divider = text at 22%.
- **Accent ramp**: 100 `#eef6ff`, 200 `#d6ebff`, 300 `#b5d9fd`, 400 `#94bce3`, 500 `#749dc4`, 600 `#597ea3`, 700 `#416180`, 800 `#2c455d`, 900 `#1d2d3d`. Use 700 for accent-colored body text.
- **Derived**: muted text = text at 68%; row rule = text at 9%; tint = accent at 12%.
- **Type**: headings Barlow Condensed 600; body Barlow 400/500/700. Body 14px, meta 12–13px, KPI numerals 40px, score numeral 64px.
- **Spacing**: 3.4 / 6.8 / 10.2 / 13.6 / 20.4 / 27.2px. Card grid gap 20px.
- **Shape**: square corners on cards, buttons, inputs, tags. Cards are transparent, 1px divider border, with 11px "+" registration marks at all four corners. The primary button is the only solid accent fill.
- **Shadows**: sm `0 1px 2px`, md `0 3px 10px`, lg `0 12px 32px` (ink-tinted).
- **Focus**: 2px accent outline, 2px offset.

## Assets
- Icons: Lucide, stroke width 1.5.
- Fonts: Barlow, Barlow Condensed (Google Fonts) — bundle them locally for offline native builds.
- App icon: `logo.webp` is the artwork as supplied. `app-icon.png` (Windows, Linux, Android, web) and
  `app-icon-macos.png` (smaller, on Apple's icon grid) are that tile cut out on a transparent square.
  To regenerate `src-tauri/icons`, run `npx tauri icon` on each and take `icon.icns` from the macOS one.
- Installer artwork is not designed yet.

## Files
- `Nexora AI.dc.html` — the prototype (template + logic in one file)
- `support.js` — prototype runtime, not for production
- `_ds/…/styles.css` — token and component stylesheet (source of truth for visual values)
- `logo.webp`, `app-icon.png`, `app-icon-macos.png` — app icon artwork
