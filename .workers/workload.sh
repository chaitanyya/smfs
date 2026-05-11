#!/bin/sh
# Deterministic-VM workload for smfs.
#
# Runs the *actual* smfs Rust binary against the captured Supermemory API
# simulation. Wenv auto-starts hoverfly with an ephemeral self-signed CA
# (because that CA changes per process restart, no client could trust it
# ahead of time). We replace it here with hoverfly using the pinned CA in
# .workers/hoverfly/, install that CA into the guest trust store, and let
# smfs talk to api.supermemory.ai over real HTTPS — proxied to the local
# mock runtime.
#
# Inputs (per wenv contract):
#   - $WENV_HOVERFLY_PID        pid of the auto-started hoverfly we replace
#   - $http_proxy / $https_proxy  point at 127.0.0.1:8500 (set by wenv)
#   - /projects/smfs            this repo, mounted read-only by wenv
#
# This script needs the smfs binary built for the guest. It searches:
#   - $SMFS_BIN                                       (caller-provided)
#   - /projects/smfs/.workers/bin/smfs                (pre-built artifact)
#   - /projects/smfs/target/x86_64-unknown-linux-musl/release/smfs
#   - /projects/smfs/target/release/smfs
#   - $(command -v smfs)                              (system install)
# If none are present and `cargo` is on PATH, it builds with
# `cargo build --release` from the project root.
#
# Stdout is meant to be byte-stable across replays under the same seed.

set -eu

PROJ=/projects/smfs
WORKERS="$PROJ/.workers"
CA="$WORKERS/hoverfly/cert.pem"
KEY="$WORKERS/hoverfly/key.pem"
SIM="$WORKERS/external-mocks.json"

API_URL="${SMFS_API:-https://api.supermemory.ai}"
TAG="${SMFS_TAG:-smfs_test_workload_v1}"
KEY_VALUE="${SMFS_KEY:-sm_replay_test_key}"

PORT="${SMFS_MOCK_PORT:-8500}"
ADMIN_PORT="${SMFS_MOCK_ADMIN_PORT:-8888}"

log() { echo "==> $*"; }
fatal() { echo "FATAL: $*" >&2; exit 1; }

# --- locate the smfs binary -------------------------------------------------

find_smfs() {
  if [ -n "${SMFS_BIN:-}" ] && [ -x "$SMFS_BIN" ]; then
    echo "$SMFS_BIN"; return 0
  fi
  for cand in \
      "$WORKERS/bin/smfs" \
      "$PROJ/target/x86_64-unknown-linux-musl/release/smfs" \
      "$PROJ/target/release/smfs"; do
    if [ -x "$cand" ]; then
      echo "$cand"; return 0
    fi
  done
  if command -v smfs >/dev/null 2>&1; then
    command -v smfs; return 0
  fi
  return 1
}

if ! SMFS=$(find_smfs); then
  if command -v cargo >/dev/null 2>&1; then
    log "smfs binary not found; building from source ($PROJ)"
    ( cd "$PROJ" && cargo build --release -p smfs )
    SMFS="$PROJ/target/release/smfs"
  else
    fatal "smfs binary not found and cargo not installed. Pre-build it into
       $WORKERS/bin/smfs (statically linked for x86_64-unknown-linux-musl)
       — see $WORKERS/build.sh for the recipe."
  fi
fi
log "using smfs at $SMFS"
"$SMFS" --version 2>&1 || true

# --- swap wenv's ephemeral hoverfly for one using the pinned CA -------------

if [ -n "${WENV_HOVERFLY_PID:-}" ]; then
  log "stopping wenv-started hoverfly (pid $WENV_HOVERFLY_PID)"
  kill "$WENV_HOVERFLY_PID" 2>/dev/null || true
  # spin until the proxy port is free
  python3 - "$PORT" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
deadline = time.monotonic() + 10.0
while time.monotonic() < deadline:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.1):
            time.sleep(0.05); continue
    except OSError:
        raise SystemExit(0)
raise SystemExit("port still bound; cannot restart hoverfly")
PY
fi

# --- install our CA into the guest trust store ------------------------------

log "installing pinned hoverfly CA into trust store"
mkdir -p /usr/local/share/ca-certificates
install -m 644 "$CA" /usr/local/share/ca-certificates/wenv-smfs-mock.crt
update-ca-certificates 2>&1 | tail -3
# rustls-tls-native-roots reads from /etc/ssl/certs (linux) which the
# update-ca-certificates step refreshes. Set SSL_CERT_FILE explicitly so any
# loader that prefers the env var picks up the bundle.
export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
export SSL_CERT_DIR=/etc/ssl/certs

# --- start hoverfly with the pinned CA + simulation -------------------------

HOVERFLY_BIN=$(command -v hoverfly || true)
[ -n "$HOVERFLY_BIN" ] || fatal "hoverfly binary not in PATH (wenv ships it; \
were you running outside --external-mocks?)"

log "starting hoverfly (cert=$CA, sim=$SIM, port=$PORT)"
"$HOVERFLY_BIN" \
    -ap "$ADMIN_PORT" -pp "$PORT" \
    -cert "$CA" -key "$KEY" \
    -import "$SIM" \
    > /tmp/wenv-smfs-hoverfly.log 2>&1 &
HOVERFLY_PID=$!

python3 - "$PORT" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
deadline = time.monotonic() + 30.0
while time.monotonic() < deadline:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            raise SystemExit(0)
    except OSError:
        time.sleep(0.05)
raise SystemExit("hoverfly never opened proxy port")
PY

log "hoverfly ready (pid $HOVERFLY_PID)"

# --- wenv exports HTTP_PROXY but smfs's reqwest reads {http,https}_proxy.
# We confirm both, just in case wenv-no-env was passed.
export http_proxy="http://127.0.0.1:$PORT"
export https_proxy="http://127.0.0.1:$PORT"
export HTTP_PROXY="$http_proxy"
export HTTPS_PROXY="$https_proxy"

# Pin SMFS_HOME under /tmp so credential + cache writes don't try to land on
# the read-only project mount.
export HOME=/tmp/smfs-home
mkdir -p "$HOME"

# --- workload ---------------------------------------------------------------
#
# This is the smfs surface we exercise without a FUSE mount. Every command
# below sends real HTTPS to api.supermemory.ai which the mock answers.
#
#   smfs login   -> GET  /v3/session             (validate_key)
#   smfs whoami  -> GET  /v3/session             (read SessionInfo + render)
#   smfs grep    -> POST /v4/search              (with optional filepath scope)
#
# Mount-driven endpoints (POST /v3/documents, POST /v3/documents/list,
# PATCH /v3/container-tags, DELETE /v3/documents/bulk, etc.) need either a
# FUSE/NFS-enabled guest plus root, or a daemon-driven runner. The mock
# simulation already covers them (see .workers/external-mocks.json) for
# when that's wired up.

log "1. smfs login"
"$SMFS" login --api-url "$API_URL" --key "$KEY_VALUE"

log "2. smfs whoami"
"$SMFS" whoami

log "3. smfs grep — semantic, container-scoped"
"$SMFS" grep "OAuth refresh tokens" --tag "$TAG"
echo
"$SMFS" grep "postgres tuning shared_buffers" --tag "$TAG"
echo
"$SMFS" grep "incident cache stampede" --tag "$TAG"
echo

log "4. smfs grep — semantic, path-scoped"
"$SMFS" grep "design review notes" /notes/ --tag "$TAG"
echo

log "workload complete"
