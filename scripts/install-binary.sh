#!/usr/bin/env bash
set -euo pipefail

# Detect OS and arch
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64)  PLATFORM="macos-arm64" ;;
      x86_64) PLATFORM="macos-x86_64" ;;
      *) echo "Unsupported macOS arch: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$ARCH" in
      x86_64)  PLATFORM="linux-x86_64" ;;
      aarch64) PLATFORM="linux-arm64" ;;
      *) echo "Unsupported Linux arch: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$PLUGIN_ROOT/bin"
BIN_PATH="$BIN_DIR/claude-session-share"

# Skip if already installed
if [[ -x "$BIN_PATH" ]]; then
  echo "claude-session-share binary already installed."
  exit 0
fi

mkdir -p "$BIN_DIR"

VERSION="0.1.0"
BASE_URL="https://github.com/tjcjc/share-session/releases/download/v${VERSION}"
URL="${BASE_URL}/claude-session-share-${PLATFORM}"

echo "Downloading claude-session-share for ${PLATFORM}..."
curl -fsSL "$URL" -o "$BIN_PATH"
chmod +x "$BIN_PATH"
echo "Installed to $BIN_PATH"
