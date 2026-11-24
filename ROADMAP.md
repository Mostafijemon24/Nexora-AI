# Nexora AI — roadmap and remaining work

Almost everything on the earlier roadmap is now built. This page lists what is **left**, and for
each item what is missing and who has to act. Everything already built, and how it was checked, is
in [PROJECT_STATUS.md](PROJECT_STATUS.md).

`[ ]` = open. Items marked **owner** cannot be done in the code: they need an account, a key or a
decision that only the owner has.

## 1. To switch on — the code is ready, an account or key is needed (owner)

- [x] **The server is on the VPS** at `https://nexora-api.avonixai.com` (installed 24 November 2026,
  behind the VPS's cPanel Apache; see [deploy/README.md](deploy/README.md)). The web app and the
  installers are built for it. *Still to do by the owner:* open the app with the license key, put
  the real name and email under Settings → My profile (the install used placeholder values), and
  set a password under Settings → Security.
- [ ] **Email delivery** for transfer codes, password resets and invitations.
  *Needed:* a mail account, set with `bash /opt/nexora/deploy/set-mail.sh` on the server. Without
  it these messages are written to the server log instead of being sent.
- [ ] **AI provider keys** — OpenAI, Google Gemini, Anthropic Claude, OpenRouter. *Postponed by the owner.*
  The connections are written and tested against scripted responses only; each needs one real key to confirm.
- [ ] **LinkedIn developer app.** *Postponed by the owner.* Sign-in and publishing are written; LinkedIn
  must approve the app and its posting permission (`w_member_social`).
- [ ] **HubSpot, Salesforce and Google Calendar developer apps** (client id and secret each, in the
  server's `.env`). The two-way sync is written and tested against scripted responses only.
- [ ] **A mailbox and a WhatsApp Business number** to connect in the app (Integrations → Email,
  WhatsApp). Sending and receiving are written and tested against scripted servers only.
- [ ] **Automatic updates** for the desktop apps. *Needed:* an updater signing key made once on the
  owner's computer and added to the repository (steps in PROJECT_STATUS.md). Updates then reach
  installed apps from the next release with a higher version number.
- [ ] **Android release.** A debug build is produced and tested in CI. *Needed for a release build:*
  an upload keystore added to the repository secrets, and a Play Console account to publish.
- [ ] **Code signing** for the Windows and macOS installers. *Postponed by the owner* — the apps
  open after a warning. *Needed:* a Windows code-signing certificate and an Apple Developer account.
- [ ] **Online payment.** *Postponed by the owner.* Plans, limits and licenses exist; licenses are
  issued, renewed and revoked from the command line. A payment provider's notifications would call
  the same functions.

## 2. Decisions for the owner

- [ ] **Prices of the new plans.** Annual plans are set to ten times the monthly price ($90, $290,
  $790), the lifetime desktop license to $349 and Enterprise to "custom". These are placeholders
  in `backend/migrations/004_accounts_plans.sql`; change them before selling.
- [ ] **Price of Gemini requests.** The server prices AI requests from a table of model prices.
  OpenAI's and Anthropic's default models are listed; Gemini's could not be confirmed and is left
  out, so Gemini usage shows tokens and "not priced". Add it with `AI_PRICES` in the server's `.env`.
- [ ] **Language of the app.** The app and its tours are in English. A Bengali interface has not been started.

## 3. Not built

- [ ] **Sending WhatsApp template messages.** A free-form WhatsApp reply only works within 24 hours
  of the person's last message (WhatsApp's rule). Starting a conversation needs an approved template,
  which is not supported yet.
- [ ] **Email attachments and formatted mail.** Replies are plain text; attachments on incoming mail are ignored.
- [ ] **Push-based mail.** New mail is read once a minute; there is no instant push.
- [ ] **Moving a workspace between servers.** Use a backup file: download it on one server, restore it on the other.
- [ ] **Transferring ownership of a workspace**, and deleting a workspace, from the app.
- [ ] **Single sign-on** (SAML or OpenID Connect) for Enterprise.
- [ ] **iOS app.**

## 4. Known limits

- A build without the server's public key (`NEXORA_LICENSE_PUBLIC_KEY`) cannot start offline; it
  needs the server each time it opens.
- Without a server, workflows only run while the app is open, and nothing can be sent or connected.
- Salesforce does not let a lead be marked "converted" through its API, so that stage is not sent
  to Salesforce; it is read from Salesforce.
- The address a workspace's webhooks call is checked to be a public https address when it is saved
  and each time it is used; a host that later changes where it points is re-checked on use.
- Reports do not show acceptance of LinkedIn connection requests: Nexora AI never reads LinkedIn.
