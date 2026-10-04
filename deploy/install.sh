#!/bin/sh
# TorexPloy installer and updater for a fresh Linux server (Ubuntu, Debian, and most distributions Docker supports).
#
#   curl -fsSL <url>/install.sh | sh                 install
#   sh install.sh update                              rebuild and restart the control plane (apps keep running)
#
# Environment:
#   TORXPLOY_SOURCE   path or git URL of the TorexPloy sources (default: the repository containing this script)
#   TORXPLOY_REF      git ref to build when TORXPLOY_SOURCE is a URL (default: main)
#   TORXPLOY_IMAGE    use a prebuilt image instead of building from source
#   TORXPLOY_PORT     host port for the dashboard before a domain is configured (default 3000; 0 = do not publish)
set -eu

DATA_DIR=/var/lib/torexploy
NETWORK=ploy
CONTAINER=ploy-control
PORT="${TORXPLOY_PORT:-3000}"
IMAGE="${TORXPLOY_IMAGE:-}"
REF="${TORXPLOY_REF:-main}"
MODE="${1:-install}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run as root (sudo sh install.sh)"
case "$MODE" in install|update) ;; *) fail "unknown command: $MODE (use install or update)" ;; esac

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker"
  command -v curl >/dev/null 2>&1 || fail "curl is required to install Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker info >/dev/null 2>&1 || fail "Docker is installed but the daemon is not running"

for port in 80 443; do
  if docker ps --format '{{.Names}} {{.Ports}}' | grep -v '^ploy-proxy ' | grep -q ":$port->"; then
    fail "port $port is already used by another container; TorexPloy's proxy needs ports 80 and 443"
  fi
  # A host web server (nginx, apache) would block the proxy too; ignore our own proxy on updates.
  if ! docker inspect ploy-proxy >/dev/null 2>&1 && command -v ss >/dev/null 2>&1 && [ -n "$(ss -ltnH "sport = :$port" 2>/dev/null)" ]; then
    fail "port $port is already in use on this host; stop the other web server (nginx, apache) first"
  fi
done

if [ -z "$IMAGE" ]; then
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")
  SOURCE="${TORXPLOY_SOURCE:-}"
  if [ -z "$SOURCE" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../Dockerfile" ]; then SOURCE="$SCRIPT_DIR/.."; fi
  [ -n "$SOURCE" ] || fail "set TORXPLOY_SOURCE to the TorexPloy repository (path or git URL), or TORXPLOY_IMAGE to a prebuilt image"
  case "$SOURCE" in
    http*://*|git@*)
      command -v git >/dev/null 2>&1 || fail "git is required to fetch $SOURCE"
      WORK=$(mktemp -d)
      trap 'rm -rf "$WORK"' EXIT
      say "Fetching $SOURCE ($REF)"
      git clone --depth 1 --branch "$REF" "$SOURCE" "$WORK/src" >/dev/null 2>&1 || fail "could not clone $SOURCE"
      SOURCE="$WORK/src"
      ;;
  esac
  say "Building the control-plane image"
  DOCKER_BUILDKIT=1 docker build -t torexploy:latest "$SOURCE"
  IMAGE=torexploy:latest
else
  say "Pulling $IMAGE"
  docker pull "$IMAGE"
fi

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create --attachable "$NETWORK" >/dev/null

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  say "Replacing the running control plane (applications keep serving)"
  docker rm -f "$CONTAINER" >/dev/null
fi

PUBLISH=""
[ "$PORT" = "0" ] || PUBLISH="-p $PORT:3000"

say "Starting TorexPloy"
# shellcheck disable=SC2086 # PUBLISH is intentionally split into flags.
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network "$NETWORK" \
  --network-alias "$CONTAINER" \
  $PUBLISH \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$DATA_DIR:/var/lib/torexploy" \
  --log-opt max-size=20m --log-opt max-file=5 \
  "$IMAGE" >/dev/null

say "Waiting for the dashboard"
i=0
until docker exec "$CONTAINER" wget -q -O /dev/null http://127.0.0.1:3000/api/health 2>/dev/null; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || fail "the control plane did not become healthy; see: docker logs $CONTAINER"
  sleep 2
done

IP=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
if [ "$MODE" = "install" ]; then
  say "TorexPloy is running"
  [ "$PORT" = "0" ] || printf '\n  Open http://%s:%s to create the administrator account.\n' "${IP:-<server-ip>}" "$PORT"
  printf '  Then set a dashboard domain in Settings → Platform to get HTTPS.\n\n'
else
  say "TorexPloy updated"
fi
