#!/usr/bin/env bash
# Install the vibe CLI (reindeer-coder command-line interface).
#
# Usage:
#   curl -fsSL https://storage.googleapis.com/reindeer-release-external/vibe/install.sh | bash
#
# Options (via env vars):
#   VIBE_INSTALL_DIR  — override install directory (default: ~/.vibe/bin)
#   VERSION           — pin a specific version (default: latest)
set -euo pipefail

BUCKET_URL="https://storage.googleapis.com/reindeer-release-external/vibe"
INSTALL_DIR="${VIBE_INSTALL_DIR:-$HOME/.vibe/bin}"

fetch() { curl -fsSL "$1"; }

# Resolve version
VERSION="${VERSION:-$(fetch "$BUCKET_URL/latest")}"
echo "Installing vibe CLI v${VERSION}..."

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS"   in darwin) P="darwin" ;; linux) P="linux" ;; *) echo "Unsupported OS: $OS" >&2; exit 1 ;; esac
case "$ARCH" in arm64|aarch64) A="arm64" ;; x86_64) A="x64" ;; *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;; esac

# Download binary + checksum
mkdir -p "$INSTALL_DIR"
fetch "$BUCKET_URL/v${VERSION}/${P}-${A}/vibe" > "$INSTALL_DIR/vibe"
fetch "$BUCKET_URL/v${VERSION}/${P}-${A}/vibe.sha256" > "$INSTALL_DIR/vibe.sha256"

# Verify integrity
echo "Verifying checksum..."
EXPECTED=$(awk '{print $1}' "$INSTALL_DIR/vibe.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$INSTALL_DIR/vibe" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$INSTALL_DIR/vibe" | awk '{print $1}')
else
  echo "Warning: neither sha256sum nor shasum found — skipping checksum verification" >&2
  ACTUAL="$EXPECTED"
fi

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "Checksum mismatch! Expected $EXPECTED, got $ACTUAL" >&2
  echo "The binary may have been tampered with. Aborting." >&2
  rm -f "$INSTALL_DIR/vibe" "$INSTALL_DIR/vibe.sha256"
  exit 1
fi
rm -f "$INSTALL_DIR/vibe.sha256"

chmod +x "$INSTALL_DIR/vibe"
echo "Installed vibe v${VERSION} to $INSTALL_DIR/vibe"

# Ensure PATH includes install dir
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  SHELL_NAME=$(basename "${SHELL:-bash}")
  case "$SHELL_NAME" in
    zsh)  RC="$HOME/.zshrc" ;;
    bash) RC="$HOME/.bashrc" ;;
    *)    RC="" ;;
  esac

  if [[ -n "$RC" ]]; then
    echo "" >> "$RC"
    echo "# vibe CLI" >> "$RC"
    echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$RC"
    echo "Added $INSTALL_DIR to PATH in $RC — restart your shell or run: source $RC"
  else
    echo "Add $INSTALL_DIR to your PATH manually."
  fi
fi
