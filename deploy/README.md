# Running the Nexora AI server

One machine runs everything: the API, the background worker, PostgreSQL, Redis and an HTTPS proxy.
Any Linux VPS with 1 GB of memory or more works.

## Before you start

1. Choose an address for the API on the same domain as the web app, for example `api.example.com`
   for an app at `app.example.com`. The two must share the domain for sign-in cookies to work.
2. In the domain's DNS add an **A record** for that name pointing at the server's IP address.

## Install

Log in to the server as root and run one command (replace the five values):

```bash
curl -fsSL https://raw.githubusercontent.com/Mostafijemon24/Nexora-AI/main/deploy/install.sh | bash -s -- api.example.com https://app.example.com owner@example.com "Owner Name" "Workspace name"
```

It installs Docker if needed, puts the code in `/opt/nexora`, generates the server's secrets into
`/opt/nexora/deploy/.env`, starts everything and creates the first license (the Business plan, five
devices, one year). At the end it prints:

- the **license key** (shown once — keep it),
- the **API address**, and
- `NEXORA_LICENSE_PUBLIC_KEY`.

## Connect the app to the server

In the GitHub repository, under *Settings → Secrets and variables → Actions → Variables*, add:

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | `https://api.example.com` |
| `NEXORA_LICENSE_PUBLIC_KEY` | the value the installer printed |

Then run the **Deploy web app** and **Release installers** workflows. From then on the web app and
the installers talk to your server, and the license key from the installer activates them.

An app that was built without a server address can also be pointed at the server by hand: on its
first screen choose *Use a different server* and enter `https://api.example.com`. This works at
once, without rebuilding anything; the two variables above make it the default for everyone and
let the desktop app start offline.

## After the first sign-in

- **Set a password** in Settings → Security. From then on a license key alone no longer opens the
  workspace, and you can invite team members (Business plan) who sign in with their own accounts.
- **Email** for codes and invitations needs `SMTP_URL` (see Day-to-day below).
- **Connections a user makes in the app** — Email (their own mailbox), WhatsApp, n8n, webhooks —
  need nothing on the server.
- **Sign-in connections** — LinkedIn, HubSpot, Salesforce, Google Calendar — each need a developer
  app with that service; put its client id and secret in `deploy/.env` (names are in
  `deploy/.env.example`) and register the redirect address
  `https://api.example.com/v1/integrations/<li|hs|sf|gc>/callback` with the service.
- **Licenses and plans**: `nexora exec api node src/cli.ts license:create --email … --name … --workspace … --plan business --months 12 --max-devices 5`.
  Plans: `starter`, `professional`, `business`, their `-annual` forms, `lifetime` and `enterprise`.

## Update

Run the installer again with no arguments; settings and data are kept:

```bash
curl -fsSL https://raw.githubusercontent.com/Mostafijemon24/Nexora-AI/main/deploy/install.sh | bash
```

To update automatically on every push to `main`, add these repository **secrets** and the
*Deploy server* workflow does the same thing over SSH: `VPS_HOST`, `VPS_USER` (usually `root`),
`VPS_SSH_KEY` (a private key whose public half is in the server's `~/.ssh/authorized_keys`), and
optionally `VPS_PORT`.

## When the server already runs other websites

If ports 80 and 443 are taken (nginx, Apache or a hosting panel), the installer does not start its
own HTTPS proxy. It prints the local port the API listens on; forward the API domain to it. For nginx:

```nginx
server {
    server_name api.example.com;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        client_max_body_size 70m;   # restoring a backup uploads the backup file
    }
}
```

Then issue a certificate for it the way your other sites get theirs (for example `certbot --nginx`).

## Day-to-day

Run these in `/opt/nexora`:

```bash
alias nexora='docker compose --env-file deploy/.env -f deploy/docker-compose.yml'
nexora ps                                  # what is running
nexora logs -f api                         # the API's log
nexora exec api node src/cli.ts help       # license commands: create, renew, revoke
nexora exec postgres pg_dump -U nexora nexora > backup.sql   # database backup
```

Email (license-transfer codes, invitations, password resets) needs `SMTP_URL` and `MAIL_FROM` in
`deploy/.env`; without them those messages are written to the API log. After editing `.env`, run
`nexora up -d`.
