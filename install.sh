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

# ── 2. Find and patch server registry ────────────────────────────────────────
SERVER_REGISTRY=""

for candidate in \
  "$PAPERCLIP_ROOT/node_modules/@paperclipai/server/dist/adapters/registry.js" \
  "$PAPERCLIP_ROOT/dist/server/src/adapters/registry.js" \
  "$PAPERCLIP_ROOT/server/dist/adapters/registry.js"; do
  if [[ -f "$candidate" ]]; then SERVER_REGISTRY="$candidate"; break; fi
done

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
  echo "ERROR: Server registry not found. Searched:"
  echo "  $PAPERCLIP_ROOT/node_modules/@paperclipai/server/dist/adapters/registry.js"
  echo ""
  echo "  Set PAPERCLIP_DIR=/path/to/paperclipai and re-run, or patch manually."
  exit 1
fi

# ── 3. Patch UI bundle ────────────────────────────────────────────────────────
UI_BUNDLE=""
UI_DIST="$PAPERCLIP_ROOT/node_modules/@paperclipai/server/ui-dist/assets"
if [[ -d "$UI_DIST" ]]; then
  for f in "$UI_DIST"/*.js; do
    if grep -q '"claude_local","codex_local"' "$f" 2>/dev/null; then
      UI_BUNDLE="$f"
      break
    fi
  done
fi

if [[ -n "$UI_BUNDLE" ]]; then
  echo "→ Patching UI bundle: $(basename "$UI_BUNDLE") ..."
  node - "$UI_BUNDLE" <<'NODE_SCRIPT'
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

let changed = false;

// Add "openrouter" to the full adapter types list (b1)
if (!src.includes('"hermes_local","openrouter"]')) {
  src = src.replace(
    /"openclaw_gateway","hermes_local"\]/,
    '"openclaw_gateway","hermes_local","openrouter"]'
  );
  changed = true;
}

// Add "openrouter" to the enabled adapters Set (pZe) so it isn't grayed out
if (!src.includes('"cursor","openrouter"]')) {
  src = src.replace(
    /new Set\(\["claude_local","codex_local","gemini_local","opencode_local","cursor"\]\)/,
    'new Set(["claude_local","codex_local","gemini_local","opencode_local","cursor","openrouter"])'
  );
  changed = true;
}

// Add display label so it shows as "OpenRouter (orager)" not "openrouter"
if (!src.includes('openrouter:"OpenRouter')) {
  src = src.replace(
    /(vle=\{[^}]*)http:"HTTP"\s*\}/,
    '$1http:"HTTP",openrouter:"OpenRouter (orager)"}'
  );
  changed = true;
}

// Allow saving when openrouter is selected
if (!src.includes('P==="cursor"||P==="openrouter"')) {
  src = src.replace(
    /P==="claude_local"\|\|P==="codex_local"\|\|P==="gemini_local"\|\|P==="opencode_local"\|\|P==="cursor"/,
    'P==="claude_local"||P==="codex_local"||P==="gemini_local"||P==="opencode_local"||P==="cursor"||P==="openrouter"'
  );
  changed = true;
}

if (!changed) {
  console.log("  (UI bundle already patched — skipping)");
  process.exit(0);
}

fs.writeFileSync(file, src, "utf8");
console.log("  Done.");
NODE_SCRIPT
else
  echo "⚠  UI bundle not found — OpenRouter will not appear in the adapter dropdown."
fi

echo ""
echo "✓ OpenRouter adapter installed."
echo ""
echo "  Restart paperclipai, then create or edit an agent and select"
echo "  'OpenRouter (orager)' as the adapter type."
echo ""
echo "  Requires: orager on PATH  →  npm install -g orager"
echo "  API key:  set OPENROUTER_API_KEY env var before starting paperclipai"
