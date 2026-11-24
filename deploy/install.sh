#!/usr/bin/env bash
# Installs or updates the Nexora AI server on this machine. Run as root on the VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/Mostafijemon24/Nexora-AI/main/deploy/install.sh \
#     | bash -s -- api.example.com https://app.example.com owner@example.com "Owner Name" "Workspace name"
#
# Arguments: <api domain> <web app address> <owner email> <owner name> <workspace name>
# Run it again with no arguments to update to the latest version; settings and data are kept.
set -euo pipefail

REPO="${NEXORA_REPO:-https://github.com/Mostafijemon24/Nexora-AI.git}"
BRANCH="${NEXORA_BRANCH:-main}"
DIR="${NEXORA_DIR:-/opt/nexora}"
ENV_FILE="$DIR/deploy/.env"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
compose() { docker compose --env-file "$ENV_FILE" -f "$DIR/deploy/docker-compose.yml" "$@"; }

# Everything runs inside main, called on the last line: bash then reads the whole script before it
# starts, so a command that reads standard input cannot swallow the rest of a script piped in from curl.
main() {
[ "$(id -u)" = 0 ] || die "run this as root (or with sudo)."

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || { say "Installing git"; (apt-get update -y && apt-get install -y git) || yum install -y git; }

say "Fetching Nexora AI ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$DIR" checkout -q -B "$BRANCH" FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$DIR"
fi

FIRST_RUN=0
if [ ! -f "$ENV_FILE" ]; then
  FIRST_RUN=1
  [ $# -ge 5 ] || die "first install needs: <api domain> <web app address> <owner email> <owner name> <workspace name>"
  API_DOMAIN="${1#https://}"; API_DOMAIN="${API_DOMAIN%/}"
  APP_ORIGIN="${2%/}"; OWNER_EMAIL="$3"; OWNER_NAME="$4"; WORKSPACE="$5"
  case "$APP_ORIGIN" in https://*) ;; *) die "the web app address must start with https://";; esac

  # Another web server on 80/443 (nginx, Apache, a hosting panel)? Then do not start our own proxy.
  PROFILES=proxy
  if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)(80|443)$'; then PROFILES=""; fi
  API_PORT=8787
  while command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:)$API_PORT\$"; do API_PORT=$((API_PORT + 1)); done

  say "Writing settings to $ENV_FILE"
  umask 077
  cat > "$ENV_FILE" <<SETTINGS
API_DOMAIN=$API_DOMAIN
APP_ORIGINS=$APP_ORIGIN
POSTGRES_PASSWORD=$(openssl rand -hex 24)
LICENSE_SIGNING_KEY=$(openssl rand -base64 32)
DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)
HASH_SECRET=$(openssl rand -hex 32)
COMPOSE_PROFILES=$PROFILES
API_PORT=$API_PORT
SETTINGS
fi

say "Building and starting the server"
compose up -d --build --remove-orphans

say "Waiting for the API"
ok=0
for _ in $(seq 1 60); do
  if [ "$(compose ps api --format '{{.Health}}' 2>/dev/null)" = healthy ]; then ok=1; break; fi
  sleep 3
done
[ "$ok" = 1 ] || { compose logs --tail 40 api migrate; die "the API did not become healthy. The log above shows why."; }

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
if [ "$FIRST_RUN" = 1 ]; then
  say "Creating the first license"
  # The owner's own license: the Business plan (team members and several workspaces), five devices, one year.
  compose exec -T api node src/cli.ts license:create --email "$OWNER_EMAIL" --name "$OWNER_NAME" --workspace "$WORKSPACE" --plan business --max-devices 5 --months 12 </dev/null
fi

say "Done"
echo "API address:               https://$API_DOMAIN"
echo "NEXORA_LICENSE_PUBLIC_KEY: $(compose exec -T api node src/cli.ts pubkey </dev/null)"
if [ -z "${COMPOSE_PROFILES:-}" ]; then
  echo
  if curl -fsS -m 10 "https://$API_DOMAIN/healthz" >/dev/null 2>&1; then
    echo "https://$API_DOMAIN answers through this server's own web server: nothing more to set up."
  else
    echo "Ports 80/443 are used by another web server, so no HTTPS proxy was started."
    echo "Forward https://$API_DOMAIN to http://127.0.0.1:${API_PORT:-8787} in that web server (deploy/README.md)."
  fi
fi
if [ "$FIRST_RUN" = 1 ]; then
  echo
  echo "Keep the license key printed above: it is shown once."
  echo "Next: set the GitHub repository variables VITE_API_URL=https://$API_DOMAIN and"
  echo "NEXORA_LICENSE_PUBLIC_KEY to the value above, then re-run the site and installer workflows."
fi
}

main "$@"
