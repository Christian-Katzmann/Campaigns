#!/usr/bin/env bash
# install.sh - verify local requirements for Campaigns.
#
# Usage:
#   ./install.sh
#
# Campaigns has no npm dependencies. This script keeps first-run setup boring:
# it checks Node, makes helper scripts executable, and prints the start command.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js 20 or newer is required." >&2
  echo "Install it from https://nodejs.org/ or your system package manager, then rerun this script." >&2
  exit 1
fi

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  echo "error: Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

chmod +x "$ROOT_DIR"/scripts/*.sh 2>/dev/null || true

# Expose the package's `campaigns` bin on PATH. `npm link` is intentional here:
# the app is installed from a local clone and has no registry dependencies.
(cd "$ROOT_DIR" && npm link --silent)

echo "Campaigns is ready."
echo "CLI installed: campaigns"
echo ""
echo "Try the sample campaign:"
echo "  npm run start:sample"
echo ""
echo "Or open your own campaign file:"
echo "  npm start -- --file path/to/your-campaign.md"
echo ""
echo "Run a campaign:"
echo "  campaigns run path/to/your-campaign.md"
