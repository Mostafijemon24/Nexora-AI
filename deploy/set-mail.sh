#!/usr/bin/env bash
# Gives the Nexora AI server a mail account, so codes, password resets and invitations are emailed
# instead of written to the log. Run as root on the server, after the server is installed:
#
#   bash /opt/nexora/deploy/set-mail.sh
#
# It asks for the SMTP details (the password is not shown and is never printed), writes SMTP_URL
# and MAIL_FROM to deploy/.env, restarts the server and sends a test message.
set -euo pipefail

DIR="${NEXORA_DIR:-/opt/nexora}"
ENV_FILE="$DIR/deploy/.env"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
compose() { docker compose --env-file "$ENV_FILE" -f "$DIR/deploy/docker-compose.yml" "$@"; }
# Reads the terminal even when the script itself arrives on standard input.
ask() { local answer; read -r -p "$1" answer </dev/tty; printf %s "$answer"; }
# Percent-encodes a value read from standard input, so any character can be part of the address.
encode() {
  compose exec -T api node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      process.stdout.write(encodeURIComponent(s).replace(/[!\x27()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()));
    });'
}

[ "$(id -u)" = 0 ] || die "run this as root (or with sudo)."
[ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist. Install the server first (deploy/README.md)."

say "Mail account for Nexora AI"
echo "Use the SMTP details of any mailbox you own; your email provider lists them as"
echo "\"SMTP\" or \"outgoing server\" settings."
HOST="$(ask 'SMTP server (for example smtp.gmail.com): ')"
PORT="$(ask 'Port [465]: ')"; PORT="${PORT:-465}"
USERNAME="$(ask 'Username (usually the full email address): ')"
read -r -s -p 'Password (not shown): ' PASSWORD </dev/tty; echo
FROM="$(ask "Send as (email address) [$USERNAME]: ")"; FROM="${FROM:-$USERNAME}"
TO="$(ask "Send the test message to [$FROM]: ")"; TO="${TO:-$FROM}"

printf %s "$HOST" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' || die "\"$HOST\" is not a server name."
printf %s "$PORT" | grep -Eq '^[0-9]{2,5}$' || die "the port must be a number, usually 465 or 587."
[ -n "$USERNAME" ] && [ -n "$PASSWORD" ] || die "the username and the password are both needed."
for address in "$FROM" "$TO"; do
  printf %s "$address" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || die "\"$address\" is not an email address."
done

# Port 465 is encrypted from the first byte; any other port must switch to encryption before signing in.
if [ "$PORT" = 465 ]; then SCHEME=smtps; OPTIONS=""; else SCHEME=smtp; OPTIONS="?requireTLS=true"; fi
URL="$SCHEME://$(printf %s "$USERNAME" | encode):$(printf %s "$PASSWORD" | encode)@$HOST:$PORT$OPTIONS"
unset PASSWORD

say "Writing the mail settings to $ENV_FILE"
umask 077
NEW="$(mktemp "$ENV_FILE.XXXXXX")"
grep -Ev '^(SMTP_URL|MAIL_FROM)=' "$ENV_FILE" > "$NEW" || true
{ printf 'SMTP_URL=%s\n' "$URL"; printf 'MAIL_FROM="Nexora AI <%s>"\n' "$FROM"; } >> "$NEW"
cp -p "$ENV_FILE" "$ENV_FILE.before-mail"
mv "$NEW" "$ENV_FILE"
unset URL

say "Restarting the server"
compose up -d
ok=0
for _ in $(seq 1 40); do
  if [ "$(compose ps api --format '{{.Health}}' 2>/dev/null)" = healthy ]; then ok=1; break; fi
  sleep 3
done
[ "$ok" = 1 ] || die "the API did not become healthy. See: docker compose --env-file $ENV_FILE -f $DIR/deploy/docker-compose.yml logs --tail 40 api"

say "Sending a test message to $TO"
if compose exec -T api node src/cli.ts mail:test --to "$TO" </dev/null; then
  echo
  echo "Done. Codes, password resets and invitations are now sent by email."
else
  echo
  echo "The settings were saved, but the test message was not sent; the reason is above."
  echo "Run this script again to correct them. The earlier settings are in $ENV_FILE.before-mail."
  exit 1
fi
