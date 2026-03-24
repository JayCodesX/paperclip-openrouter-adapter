#!/usr/bin/env bash
# install.sh — install the OpenRouter (orager) adapter into a paperclipai global install.
#
# Usage:
#   bash /path/to/paperclip-openrouter-adapter/install.sh
#
# The script auto-detects the paperclipai global install location.
# You can also override it:
#   PAPERCLIP_DIR=/opt/homebrew/lib/node_modules/paperclipai bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Locate paperclipai global install ─────────────────────────────────────────
if [[ -n "${PAPERCLIP_DIR:-}" ]]; then
  PAPERCLIP_ROOT="$PAPERCLIP_DIR"
else
  # Try npm global root
  NPM_GLOBAL="$(npm root -g 2>/dev/null || true)"
  if [[ -d "$NPM_GLOBAL/paperclipai" ]]; then
    PAPERCLIP_ROOT="$NPM_GLOBAL/paperclipai"
  # Try common Homebrew locations
  elif [[ -d "/opt/homebrew/lib/node_modules/paperclipai" ]]; then
    PAPERCLIP_ROOT="/opt/homebrew/lib/node_modules/paperclipai"
  elif [[ -d "/usr/local/lib/node_modules/paperclipai" ]]; then
    PAPERCLIP_ROOT="/usr/local/lib/node_modules/paperclipai"
  else
    echo "ERROR: Cannot find paperclipai global install."
    echo "       Set PAPERCLIP_DIR=/path/to/paperclipai and re-run."
    exit 1
  fi
fi

ADAPTER_MODULES="$PAPERCLIP_ROOT/node_modules/@paperclipai"

if [[ ! -d "$ADAPTER_MODULES" ]]; then
  echo "ERROR: $ADAPTER_MODULES does not exist."
  echo "       Is paperclipai installed at $PAPERCLIP_ROOT?"
  exit 1
fi

echo "→ Found paperclipai at: $PAPERCLIP_ROOT"

# ── 1. Copy adapter package ───────────────────────────────────────────────────
ADAPTER_DEST="$ADAPTER_MODULES/adapter-openrouter"
echo "→ Copying adapter to $ADAPTER_DEST ..."
rm -rf "$ADAPTER_DEST"
cp -r "$SCRIPT_DIR/openrouter" "$ADAPTER_DEST"

# ── 2. Find and patch registry files ─────────────────────────────────────────
# Registry files may be in dist/ or src/ depending on how paperclipai was built.
SERVER_REGISTRY=""
UI_REGISTRY=""
CLI_REGISTRY=""

for candidate in \
  "$PAPERCLIP_ROOT/node_modules/@paperclipai/server/dist/adapters/registry.js" \
  "$PAPERCLIP_ROOT/dist/server/src/adapters/registry.js" \
  "$PAPERCLIP_ROOT/server/dist/adapters/registry.js"; do
  if [[ -f "$candidate" ]]; then SERVER_REGISTRY="$candidate"; break; fi
done

for candidate in \
  "$PAPERCLIP_ROOT/dist/ui/src/adapters/registry.js" \
  "$PAPERCLIP_ROOT/ui/dist/adapters/registry.js"; do
  if [[ -f "$candidate" ]]; then UI_REGISTRY="$candidate"; break; fi
done

for candidate in \
  "$PAPERCLIP_ROOT/dist/adapters/registry.js" \
  "$PAPERCLIP_ROOT/dist/cli/src/adapters/registry.js" \
  "$PAPERCLIP_ROOT/cli/dist/adapters/registry.js"; do
  if [[ -f "$candidate" ]]; then CLI_REGISTRY="$candidate"; break; fi
done

# ── 2a. Patch server registry ─────────────────────────────────────────────────
if [[ -n "$SERVER_REGISTRY" ]]; then
  echo "→ Patching server registry: $SERVER_REGISTRY ..."
  node - "$SERVER_REGISTRY" <<'NODE_SCRIPT'
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

if (src.includes("adapter-openrouter")) {
  console.log("  (server registry already contains openrouter — skipping)");
  process.exit(0);
}

const serverImport = `import {
  execute as openrouterExecute,
  testEnvironment as openrouterTestEnvironment,
  sessionCodec as openrouterSessionCodec,
} from "@paperclipai/adapter-openrouter/server";
import { agentConfigurationDoc as openrouterAgentConfigurationDoc, models as openrouterModels } from "@paperclipai/adapter-openrouter";
`;
// Insert before first import
src = src.replace(/^(import )/, serverImport + "$1");

const adapterDef = `const openrouterAdapter = {
  type: "openrouter",
  execute: openrouterExecute,
  testEnvironment: openrouterTestEnvironment,
  sessionCodec: openrouterSessionCodec,
  models: openrouterModels,
  supportsLocalAgentJwt: false,
  agentConfigurationDoc: openrouterAgentConfigurationDoc,
};

`;
src = src.replace(/(const adaptersByType)/, adapterDef + "$1");
src = src.replace(/(processAdapter,\n\s*httpAdapter,)/, "openrouterAdapter,\n    $1");

fs.writeFileSync(file, src, "utf8");
console.log("  Done.");
NODE_SCRIPT
else
  echo "⚠  Server registry not found — skipping (you may need to patch manually)."
fi

# ── 2b. Patch UI registry ──────────────────────────────────────────────────────
if [[ -n "$UI_REGISTRY" ]]; then
  echo "→ Patching UI registry: $UI_REGISTRY ..."
  node - "$UI_REGISTRY" <<'NODE_SCRIPT'
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

if (src.includes("openrouter")) {
  console.log("  (UI registry already contains openrouter — skipping)");
  process.exit(0);
}

src = src.replace(
  /(import \{ httpUIAdapter \} from ["']\.\/http["'];?)/,
  '$1\nimport { openrouterUIAdapter } from "./openrouter";'
);
src = src.replace(/(  httpUIAdapter,)/, "  openrouterUIAdapter,\n$1");

fs.writeFileSync(file, src, "utf8");
console.log("  Done.");
NODE_SCRIPT
else
  echo "⚠  UI registry not found — skipping."
fi

# ── 2c. Patch CLI registry ─────────────────────────────────────────────────────
if [[ -n "$CLI_REGISTRY" ]]; then
  echo "→ Patching CLI registry: $CLI_REGISTRY ..."
  node - "$CLI_REGISTRY" <<'NODE_SCRIPT'
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

if (src.includes("adapter-openrouter")) {
  console.log("  (CLI registry already contains openrouter — skipping)");
  process.exit(0);
}

const cliImport = `import { printOpenRouterStreamEvent } from "@paperclipai/adapter-openrouter/cli";\n`;
src = src.replace(/^(import )/, cliImport + "$1");

const cliDef = `const openrouterCLIAdapter = {
  type: "openrouter",
  formatStdoutEvent: printOpenRouterStreamEvent,
};

`;
src = src.replace(/(const adaptersByType)/, cliDef + "$1");
src = src.replace(/(processCLIAdapter,\n\s*httpCLIAdapter,)/, "openrouterCLIAdapter,\n    $1");

fs.writeFileSync(file, src, "utf8");
console.log("  Done.");
NODE_SCRIPT
else
  echo "⚠  CLI registry not found — skipping."
fi

echo ""
echo "✓ OpenRouter adapter installed."
echo ""
echo "  Restart paperclipai, then create or edit an agent and select"
echo "  'OpenRouter (orager)' as the adapter type."
echo ""
echo "  Requires: orager on PATH  →  npm install -g @paperclipai/orager"
echo "  API key:  set apiKey in agent config, or OPENROUTER_API_KEY env var"
echo ""
echo "  If registries were not auto-patched, their locations need to be"
echo "  identified manually. Run with DEBUG=1 to print the search paths."
