#!/usr/bin/env bash
# install.sh — drop the OpenRouter (orager) adapter into a Paperclip monorepo.
#
# Usage (run from the paperclip repo root):
#   bash /path/to/paperclip-openrouter-adapter/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAPERCLIP_ROOT="$(pwd)"

# ── Sanity check ──────────────────────────────────────────────────────────────
if [[ ! -f "$PAPERCLIP_ROOT/pnpm-workspace.yaml" ]]; then
  echo "ERROR: Run this script from the root of the Paperclip monorepo."
  echo "       (expected pnpm-workspace.yaml at $(pwd))"
  exit 1
fi

# ── 1. Copy adapter package ───────────────────────────────────────────────────
echo "→ Copying packages/adapters/openrouter/ ..."
cp -r "$SCRIPT_DIR/openrouter" "$PAPERCLIP_ROOT/packages/adapters/openrouter"

# ── 2. Copy UI adapter module ─────────────────────────────────────────────────
echo "→ Copying ui/src/adapters/openrouter/ ..."
mkdir -p "$PAPERCLIP_ROOT/ui/src/adapters/openrouter"
cp "$SCRIPT_DIR/ui-adapter/index.ts"       "$PAPERCLIP_ROOT/ui/src/adapters/openrouter/index.ts"
cp "$SCRIPT_DIR/ui-adapter/config-fields.tsx" "$PAPERCLIP_ROOT/ui/src/adapters/openrouter/config-fields.tsx"

# ── 3. Patch the three registry files ────────────────────────────────────────
echo "→ Patching server/src/adapters/registry.ts ..."
node - "$PAPERCLIP_ROOT/server/src/adapters/registry.ts" <<'NODE_SCRIPT'
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

if (src.includes("adapter-openrouter")) {
  console.log("  (server registry already contains openrouter — skipping)");
  process.exit(0);
}

// Insert import block right before the first existing import
const serverImport = `import {
  execute as openrouterExecute,
  testEnvironment as openrouterTestEnvironment,
  sessionCodec as openrouterSessionCodec,
} from "@paperclipai/adapter-openrouter/server";
import { agentConfigurationDoc as openrouterAgentConfigurationDoc, models as openrouterModels } from "@paperclipai/adapter-openrouter";
`;
src = src.replace(/^(import )/, serverImport + "$1");

// Insert adapter definition before the adaptersByType map
const adapterDef = `const openrouterAdapter: ServerAdapterModule = {
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

// Add openrouterAdapter into the Map initializer array
src = src.replace(/(processAdapter,\n\s*httpAdapter,)/, "openrouterAdapter,\n    $1");

fs.writeFileSync(file, src, "utf8");
console.log("  Done.");
NODE_SCRIPT

echo "→ Patching ui/src/adapters/registry.ts ..."
node - "$PAPERCLIP_ROOT/ui/src/adapters/registry.ts" <<'NODE_SCRIPT'
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

if (src.includes("openrouter")) {
  console.log("  (ui registry already contains openrouter — skipping)");
  process.exit(0);
}

// Add import after last existing adapter import
src = src.replace(/(import \{ httpUIAdapter \} from "\.\/http";)/, '$1\nimport { openrouterUIAdapter } from "./openrouter";');

// Add to the uiAdapters array before httpUIAdapter
src = src.replace(/(  httpUIAdapter,)/, "  openrouterUIAdapter,\n$1");

fs.writeFileSync(file, src, "utf8");
console.log("  Done.");
NODE_SCRIPT

echo "→ Patching cli/src/adapters/registry.ts ..."
node - "$PAPERCLIP_ROOT/cli/src/adapters/registry.ts" <<'NODE_SCRIPT'
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

if (src.includes("adapter-openrouter")) {
  console.log("  (cli registry already contains openrouter — skipping)");
  process.exit(0);
}

// Insert import
const cliImport = `import { printOpenRouterStreamEvent } from "@paperclipai/adapter-openrouter/cli";\n`;
src = src.replace(/^(import )/, cliImport + "$1");

// Insert adapter definition before adaptersByType
const cliDef = `const openrouterCLIAdapter: CLIAdapterModule = {
  type: "openrouter",
  formatStdoutEvent: printOpenRouterStreamEvent,
};

`;
src = src.replace(/(const adaptersByType)/, cliDef + "$1");

// Add to map
src = src.replace(/(processCLIAdapter,\n\s*httpCLIAdapter,)/, "openrouterCLIAdapter,\n    $1");

fs.writeFileSync(file, src, "utf8");
console.log("  Done.");
NODE_SCRIPT

# ── 4. Install dependencies ───────────────────────────────────────────────────
echo "→ Running pnpm install ..."
cd "$PAPERCLIP_ROOT"
pnpm install

echo ""
echo "✓ OpenRouter adapter installed."
echo ""
echo "  Restart Paperclip, then create or edit an agent and select"
echo "  'OpenRouter (orager)' as the adapter type."
echo ""
echo "  Requires: orager on PATH  →  npm install -g @paperclipai/orager"
echo "  API key:  set apiKey in agent config, or OPENROUTER_API_KEY env var"
