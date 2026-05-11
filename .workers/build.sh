#!/bin/sh
# Build smfs for the wenv alpine guest (linux x86_64 musl, statically linked).
#
# Output: $REPO/.workers/bin/smfs
#
# Run this on a linux x86_64 host with rust + musl-tools, OR on macOS with
# the FiloSottile musl-cross toolchain (`brew install
# FiloSottile/musl-cross/musl-cross`). For other layouts, set CC and
# CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER manually before running.

set -eu

cd "$(dirname "$0")/.."

REPO=$(pwd)
TARGET=x86_64-unknown-linux-musl
OUT_DIR="$REPO/.workers/bin"
mkdir -p "$OUT_DIR"

if ! rustup target list --installed 2>/dev/null | grep -q "^$TARGET\$"; then
  echo "==> installing rust target $TARGET"
  rustup target add "$TARGET"
fi

UNAME=$(uname -s)
case "$UNAME" in
  Darwin)
    if ! command -v x86_64-linux-musl-gcc >/dev/null; then
      echo "FATAL: need x86_64-linux-musl-gcc on macOS." >&2
      echo "       Install via: brew install FiloSottile/musl-cross/musl-cross" >&2
      exit 1
    fi
    export CC_x86_64_unknown_linux_musl=x86_64-linux-musl-gcc
    export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-linux-musl-gcc
    ;;
  Linux)
    if ! command -v musl-gcc >/dev/null; then
      echo "WARN: musl-gcc not in PATH; cargo will try the default linker." >&2
    else
      export CC_x86_64_unknown_linux_musl=musl-gcc
      export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc
    fi
    ;;
esac

echo "==> cargo build --release --target $TARGET -p smfs"
cargo build --release --target "$TARGET" -p smfs

BIN="$REPO/target/$TARGET/release/smfs"
install -m 755 "$BIN" "$OUT_DIR/smfs"
echo "==> wrote $OUT_DIR/smfs ($(du -h "$OUT_DIR/smfs" | cut -f1))"
file "$OUT_DIR/smfs" 2>/dev/null || true
