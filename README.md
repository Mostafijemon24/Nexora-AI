<p align="center">
  <img src="docs/images/banner.png" alt="Nexora AI — LinkedIn growth and lead intelligence" width="100%">
</p>

<p align="center">
  <a href="README.bn.md">বাংলায় পড়ুন</a> ·
  <a href="#see-it-in-action">Demo</a> ·
  <a href="#download">Download</a> ·
  <a href="#plans-and-why-a-subscription">Plans</a> ·
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="#for-developers">Developers</a>
</p>

<p align="center">
  <a href="https://github.com/Mostafijemon24/Nexora-AI/actions/workflows/ci.yml"><img src="https://github.com/Mostafijemon24/Nexora-AI/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

# Nexora AI

**Nexora AI is a workspace for growing a business through LinkedIn.** It tells you which leads are
worth your time, helps you write posts and replies with AI, keeps every conversation in one inbox,
and never does anything on LinkedIn that LinkedIn does not allow.

It is one application that runs in the browser and as a desktop app on Windows, macOS and Linux,
with the same data everywhere. Created by [Mostafijemon24](https://github.com/Mostafijemon24).

## See it in action

<p align="center">
  <img src="docs/media/nexora-ai-tour.gif" alt="A 37-second tour of Nexora AI" width="100%">
</p>

<p align="center"><sub>A 37-second tour: activation, dashboard, lead scoring, writing a post, replying, automation, dark mode.
<a href="docs/media/nexora-ai-tour.mp4">Download the video (MP4)</a></sub></p>

## Who it is for

- **Founders and solo consultants** who find clients on LinkedIn and have no time to sort a long lead list by hand.
- **Small agencies and sales teams** who want one place for leads, content and replies instead of five tabs and a spreadsheet.
- **Anyone who refuses to risk their LinkedIn account** on scraping tools and auto-clickers.

## The problem it solves

| Without Nexora AI | With Nexora AI |
| --- | --- |
| A list of 500 leads and no idea who to contact first | Every lead scored 0–100 against your ideal customer, with the reason shown |
| A blank page every time you need to post | A draft post in your brand voice in seconds, which you edit and approve |
| Replies scattered across email, WhatsApp and notes | One inbox, with a suggested reply for each conversation |
| Follow-ups forgotten | Follow-up tasks created from any conversation, shown on your dashboard |
| Tools that scrape LinkedIn and get accounts restricted | Official connections and manual steps only — nothing automated behind your back |
| No internet, no work | The desktop app keeps working offline and syncs when you are back |

## What you can do with it

### Know who to talk to first

<img src="docs/images/lead-scoring.png" alt="Lead scoring" width="100%">

Describe your ideal customer once — industry, job titles, company size, location. Every lead gets a
score out of 100 and a breakdown of how it was reached. A separate **confidence** number shows how
much data the score rests on. If a detail is missing, Nexora AI says *"Not available — not guessed"*
and gives no points for it; it never makes facts up.

### Write posts without the blank page

<img src="docs/images/content-generator.png" alt="Content generator" width="100%">

Give a topic, an audience and a tone. You get a hook, a body, a call to action and hashtags, all
editable. Posts move through **Draft → In review → Approved → Scheduled → Published**, and a weekly
calendar shows what goes out when. Nothing is published without your approval.

<img src="docs/images/content-calendar.png" alt="Content calendar" width="100%">

### Answer every conversation from one place

<img src="docs/images/communication.png" alt="Communication inbox" width="100%">

Each conversation shows what the person wants and how they sound. The AI suggests a reply, but it is
only a suggestion: you press **Use**, edit it, and send it yourself. Internal notes stay with the
conversation for your team.

### Ask the assistant

<img src="docs/images/ai-assistant.png" alt="AI assistant" width="100%">

Ask about your own leads, posts and replies. The assistant only uses the data in your workspace and
tells you when something is missing.

### Design your follow-up process

<img src="docs/images/automation.png" alt="Automation workflows" width="100%">

Lay out a workflow as numbered steps — a trigger, conditions, an AI draft, an approval, a status
change. A workflow with an approval step always stops and waits for you.

### Connect your tools, and bring your own AI

<img src="docs/images/integrations.png" alt="Integrations" width="100%">

Connect a CRM, a calendar and messaging channels, and import leads from a CSV file. For AI you use
your own key with **OpenAI, Google Gemini, Anthropic Claude or OpenRouter**, choose which one handles
each kind of task, and set a monthly spending limit.

<img src="docs/images/settings-ai.png" alt="AI provider settings with the OpenRouter model list" width="100%">

### See the whole picture

<img src="docs/images/dashboard-dark.png" alt="Dashboard in dark mode" width="100%">

The dashboard shows new leads, unread conversations, scheduled posts, the lead funnel and your
tasks for the last 7, 30 or 90 days. Light and dark themes are both built in.

### Keep working without internet

<img src="docs/images/desktop-offline.png" alt="The desktop app working offline" width="100%">

On the desktop app, press **Go offline** or simply lose your connection: what you write is saved on
your computer, counted in the header, and sent to the cloud the moment you reconnect — each change
exactly once.

### On a phone-sized screen

<img src="docs/images/mobile.png" alt="Nexora AI on a phone-sized screen" width="100%">

The same app rearranges itself for a small screen with a bottom navigation bar. A packaged Android
app is on the [roadmap](ROADMAP.md).

## How it works

```mermaid
flowchart LR
  subgraph You["Your devices"]
    W["Web app<br/>(browser)"]
    D["Desktop app<br/>Windows · macOS · Linux"]
  end
  subgraph Cloud["Nexora AI server"]
    L["License server<br/>one license · one device"]
    A["Workspace API<br/>leads · posts · inbox · workflows"]
    G["AI gateway<br/>your own provider keys"]
    DB[("Database")]
  end
  P["OpenAI · Gemini<br/>Claude · OpenRouter"]
  W --> L
  D --> L
  W --> A
  D --> A
  A --> DB
  L --> DB
  A --> G --> P
  D -. "works offline,<br/>syncs later" .-> A
```

1. **Activate.** You enter your license key once. The server checks it and registers your device.
2. **Work.** Your leads, posts, conversations and workflows live in your own workspace on the server, so the web and desktop apps always show the same thing.
3. **Use AI on your terms.** AI requests go through the server with *your* provider key, which is stored encrypted and never sent back to any device.
4. **Stay in control.** AI only drafts. Sending a reply, publishing a post and approving a workflow run are always your decision.

## What it will never do

Nexora AI is built to keep your LinkedIn account safe.

| Uses | Does not use |
| --- | --- |
| LinkedIn's official sign-in and approved permissions | Your LinkedIn password |
| CSV import, message drafts, reminders you act on | Scraping |
| Channels you connect yourself | Automated clicking or mass connection requests |
| | Reading your private LinkedIn inbox |

## Plans and why a subscription

A subscription is what keeps Nexora AI running for you, not a one-off download. It pays for:

- **Your license** — the key that unlocks the app on your device and protects your workspace. One license runs on one device at a time; you can move it to a new device yourself with an email code.
- **The cloud workspace** — secure storage, sync between web and desktop, and backups.
- **The server side of AI** — routing, usage tracking, spending limits and encrypted key storage. (The AI provider's own usage is billed by the provider to your own key, so you only pay for what you use.)
- **Updates and new features** — everything on the [roadmap](ROADMAP.md), as it ships.
- **Support** when something goes wrong.

Without an active license the app stays on the activation screen, on every device.

| | Starter | Professional | Business |
| --- | --- | --- | --- |
| **Price** | **$9** / month | **$29** / month | **$79** / month |
| Lead scoring, AI assistant, prompt library | ✓ | ✓ | ✓ |
| Content studio and calendar | ✓ | ✓ | ✓ |
| Unified inbox with suggested replies | ✓ | ✓ | ✓ |
| Workflow builder, integrations | | ✓ | ✓ |
| Web and desktop apps, offline mode | | ✓ | ✓ |
| Team members, roles, several workspaces *(planned)* | | | ✓ |
| Priority support *(planned)* | | | ✓ |

> These prices and plan contents are the intended launch offer and may change before public
> launch. Online payment is not connected yet — today licenses are issued directly by the owner.
> Third-party costs (your AI provider, LinkedIn API access) are separate.

## Download

Installers for **Windows** (`.exe`, `.msi`), **macOS** (`.dmg`, Apple Silicon and Intel) and
**Linux** (`.deb`, `.rpm`, `.AppImage`) are published on the
[Releases page](https://github.com/Mostafijemon24/Nexora-AI/releases).

The current installers are a **preview that runs without a server**. Use the key `NXR-VALID-0001`
to get in. The workspace starts empty and a short tour introduces each page the first time you open
it (the **?** button in the header replays it). What you add is kept on that device. Without a
server, integrations and AI provider keys cannot be connected (LinkedIn sign-in included) and AI
answers are built-in examples. The installers are not code-signed yet, so Windows and macOS will
show a warning the first time you open them.

**macOS, first launch.** If macOS says the app cannot be verified, open **System Settings → Privacy
& Security** and click **Open Anyway**. If it says *"Nexora AI.app" is damaged and can't be opened*,
the app is not damaged — macOS blocks unsigned downloads this way. Click **Cancel** (not *Move to
Trash*), move the app to **Applications**, then run this once in Terminal and open the app again:

```bash
xattr -cr "/Applications/Nexora AI.app"
```

## Try the prototype

- **In your browser, from this repository:** `npm install && npm run dev`, open
  `http://localhost:1420`, and activate with `NXR-VALID-0001`. Add `?platform=android` (or
  `windows`, `macos`, `linux`) to the address to preview that layout, or `?sample` to fill the
  workspace with sample data.
- **The original clickable design prototype:** download the [`design/`](design) folder and open
  `Nexora AI.dc.html`. It is the design the app was built from.

Other sample keys show each activation outcome: `NXR-EXPIRED-0002`, `NXR-REVOKED-0003`,
`NXR-INUSE-0004` (transfer with any 6-digit code), `NXR-OFFLINE-0005`.

<img src="docs/images/license-gate.png" alt="License activation when the key is in use on another device" width="100%">

## What is coming next

The short version — the full, tracked list is in **[ROADMAP.md](ROADMAP.md)**.

- Sign-in with email and password, team members and roles
- Online payment and self-service subscription management
- Sending replies through email and WhatsApp, and receiving messages automatically
- Workflows that run on their own when a trigger fires
- Two-way sync with HubSpot, Salesforce and Google Calendar
- An Android app
- Signed installers and automatic updates
- Campaign management, a fuller lead CRM, and deeper analytics and reports

## For developers

| Part | Where | Built with |
| --- | --- | --- |
| App (web + desktop UI) | [`src/`](src) | React, TypeScript, Vite |
| Desktop shell | [`src-tauri/`](src-tauri) | Tauri 2, Rust |
| Offline queue and license-token verification | [`crates/nexora-core/`](crates/nexora-core) | Rust, SQLite, Ed25519 |
| API, license server, AI gateway | [`backend/`](backend) | Node 22, PostgreSQL, optional Redis |
| Design reference | [`design/`](design) | HTML prototype and design system |

```bash
npm install
npm run dev              # web app without a server, http://localhost:1420 (add ?sample for sample data)
npm run tauri dev        # desktop app (needs the Tauri 2 prerequisites)
npm test                 # app tests
cargo test --workspace   # Rust tests
```

To run the real server and connect the app to it, follow **[backend/README.md](backend/README.md)**.
What has been built, what has been verified and how is recorded in
**[PROJECT_STATUS.md](PROJECT_STATUS.md)**.

Every push runs all three test suites on GitHub Actions; the *Release installers* workflow builds
the desktop installers.

## License

© 2026 Mostafijemon24. All rights reserved. This source code is published for reference; it may
not be copied, modified or redistributed without written permission.
