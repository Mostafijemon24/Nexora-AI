# Nexora AI — roadmap and remaining work

This is the complete list of what is **not built yet**. Everything already built and verified is in
[PROJECT_STATUS.md](PROJECT_STATUS.md).

Each item says what is missing today and what is needed before it can be built.
`[ ]` = not started.

## 1. Needed before real customers can use it

- [ ] **Run the server in production.**
  *Today:* the server has only run on a development machine; the published installers run without it: data stays on the device and AI is simulated.
  *Needed:* hosting, a domain with https, a PostgreSQL database (Redis optional). Then set the
  repository variables `VITE_API_URL` and `NEXORA_LICENSE_PUBLIC_KEY` and re-run the
  *Release installers* workflow to produce installers that talk to the real server.
- [ ] **Verify each AI provider with a real key** — OpenAI, Google Gemini, Anthropic Claude, OpenRouter.
  *Today:* the connections are written and tested against simulated responses only.
  *Needed:* one API key per provider; confirm the default model names in the server settings.
- [ ] **Verify each sign-in integration with a real account** — LinkedIn, HubSpot, Salesforce, Google Calendar.
  *Today:* the connection flow is built and tested against simulated responses only.
  *Needed:* a developer app (client id and secret) with each provider; LinkedIn must approve the permissions.
- [ ] **Real email delivery for license-transfer codes.**
  *Today:* without mail settings the code is written to the server log.
  *Needed:* an SMTP account.
- [ ] **Code signing** for the Windows and macOS installers, so they open without a warning.
  *Today:* the macOS app is ad-hoc signed, so it opens after *Open Anyway*; the release workflow
  signs and notarizes it as soon as the Apple secrets listed in `release.yml` are added.
  *Needed:* a Windows code-signing certificate and an Apple Developer account.

## 2. Product features not built yet

- [ ] **Sign-in and team members** — email and password, password reset, inviting teammates, roles and permissions.
  *Today:* a license activated on a device is the only identity. The MFA switch in Settings is saved but does nothing.
  *Needed first:* a design for the sign-in, registration and team screens.
- [ ] **Online payment and subscriptions** — checkout, renewal, cancellation, invoices.
  *Today:* plans exist in the database; licenses are created, renewed and revoked from the command line.
  *Needed:* a payment provider account. Its notifications will call the license functions that already exist.
- [ ] **Sending and receiving messages** — deliver replies by email and WhatsApp; bring incoming messages in automatically.
  *Today:* a reply is saved in the conversation but is not sent anywhere.
  *Needed:* an email-sending account and a WhatsApp Business account.
- [ ] **Workflows that run by themselves.**
  *Today:* workflows can be designed, test-run and approved, but no step is carried out.
  *Needed first:* a precise definition of each step type (which triggers exist, what a condition can
  test, what each action changes). Steps are free text at the moment.
- [ ] **Two-way data sync** with HubSpot, Salesforce and Google Calendar.
  *Today:* these can be connected and tested, but no contacts or events are exchanged.
- [ ] **Publishing to LinkedIn** through the official API.
  *Today:* "Mark published" is a manual reminder.
  *Needed:* LinkedIn's approval of the posting permission.
- [ ] **Backup restore and download.**
  *Today:* "Back up now" stores a copy on the server; it cannot be restored or downloaded yet.
- [ ] **Self-hosted server address and region choice.**
  *Today:* both are saved in Settings but the app always uses the address it was built with.

## 3. Platforms

- [ ] **Android app.**
  *Today:* the layout and bottom navigation work at phone size; no installable app exists.
  *Needed:* an approach for storing the session securely on Android (the app refuses to store it
  insecurely), then the Android project setup and a Play Store account.
- [ ] **Automatic updates** for the desktop apps.
- [ ] **Run-through on Windows and macOS.**
  *Today:* installers are built for both, but only the Linux app has been run and tested.
- [ ] **Installer artwork** (DMG background, Windows installer images). The app icon is final.

## 4. Planned modules from the product blueprint

These were in the original product plan and are not part of version 1.

- [ ] **Advanced lead CRM** — pipeline stages, tags, lead detail pages, bulk actions.
- [ ] **Campaign management** — plan, run and measure outreach campaigns.
- [ ] **Analytics and reporting** — acceptance, reply and conversion rates, AI cost, exports.
- [ ] **Workspace and team management** — several workspaces, shared prompt and reply libraries.
- [ ] **Annual plans, a lifetime desktop license and an enterprise plan.**

## 5. Smaller known gaps

- [ ] Moving a license on a multi-device plan deactivates all its devices, not one chosen device.
- [ ] A desktop app that loses its saved session must use the transfer flow to get back in.
- [ ] The sessions list shows the device and last-seen time, but no location.
- [ ] AI spending is shown in dollars only for OpenRouter; other providers are counted in tokens.
- [ ] The differences between plans (which features each plan includes) are not enforced; only the device limit is.
- [ ] The server's container image has been written but never built or run.
