#!/usr/bin/env bash
# Build the Baiton VSIX and install it into VS Code.
# Usage: scripts/build-install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v code >/dev/null 2>&1; then
  echo "error: 'code' CLI not found on PATH" >&2
  exit 1
fi

echo "==> Installing dependencies"
npm install

echo "==> Compiling (copy:media + tsc)"
npm run package

echo "==> Packaging VSIX"
npx vsce package

VSIX="$(ls -t baiton-*.vsix | head -n 1)"

echo "==> Verifying $VSIX"
node scripts/check-vsix.js "$VSIX"

echo "==> Installing $VSIX"
code --install-extension "$VSIX" --force

echo "==> Installed:"
code --list-extensions --show-versions | grep -i '^baiton\.' || true
echo "Reload the VS Code window to load the new build."
