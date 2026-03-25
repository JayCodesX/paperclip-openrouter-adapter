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
    # Try resolving via the paperclipai binary on PATH (works for any install method)
    PAPERCLIPAI_BIN="$(command -v paperclipai 2>/dev/null || true)"
    if [[ -n "$PAPERCLIPAI_BIN" ]]; then
      # Follow symlinks to the real file, then walk up to the package root
      REAL_BIN="$(readlink -f "$PAPERCLIPAI_BIN" 2>/dev/null || realpath "$PAPERCLIPAI_BIN" 2>/dev/null || echo "$PAPERCLIPAI_BIN")"
      CANDIDATE="$(dirname "$(dirname "$REAL_BIN")")/lib/node_modules/paperclipai"
      if [[ ! -d "$CANDIDATE" ]]; then
        # The binary might live inside the package itself (e.g. dist/index.js)
        CANDIDATE="$(dirname "$(dirname "$REAL_BIN")")"
      fi
      if [[ -d "$CANDIDATE" && -f "$CANDIDATE/package.json" ]]; then
        PAPERCLIP_ROOT="$CANDIDATE"
      fi
    fi

    # Try npx cache (used when paperclipai is run via `npx paperclipai`)
    if [[ -z "${PAPERCLIP_ROOT:-}" ]]; then
      NPX_HIT="$(find "$HOME/.npm/_npx" -maxdepth 4 -type d -name "paperclipai" 2>/dev/null \
        | grep "node_modules/paperclipai$" | head -1)"
      if [[ -d "$NPX_HIT" ]]; then
        PAPERCLIP_ROOT="$NPX_HIT"
      fi
    fi

    if [[ -z "${PAPERCLIP_ROOT:-}" ]]; then
      echo "ERROR: Cannot find paperclipai. Install it first, then re-run:"
      echo ""
      echo "  npm install -g paperclipai"
      echo "  bash install.sh"
      echo ""
      echo "Or point directly to your install:"
      echo "  PAPERCLIP_DIR=/path/to/paperclipai bash install.sh"
      exit 1
    fi
  fi
fi

# The @paperclipai modules may be nested inside paperclipai's own node_modules
# (traditional global install) or as siblings in a flat node_modules layout
# (npx cache). Try nested first, then fall back to sibling.
if [[ -d "$PAPERCLIP_ROOT/node_modules/@paperclipai" ]]; then
  ADAPTER_MODULES="$PAPERCLIP_ROOT/node_modules/@paperclipai"
elif [[ -d "$(dirname "$PAPERCLIP_ROOT")/@paperclipai" ]]; then
  ADAPTER_MODULES="$(dirname "$PAPERCLIP_ROOT")/@paperclipai"
else
  echo "ERROR: Cannot find @paperclipai modules."
  echo "       Searched: $PAPERCLIP_ROOT/node_modules/@paperclipai"
  echo "                 $(dirname "$PAPERCLIP_ROOT")/@paperclipai"
  exit 1
fi

# For registry patching, constants.js, and UI dist we also need to know
# the top-level node_modules root (parent of @paperclipai).
NODE_MODULES_ROOT="$(dirname "$ADAPTER_MODULES")"

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

# ── 1b. Copy orager skills into adapter package ───────────────────────────────
# Our exec-based skills (get-task, post-comment, list-issues, update-issue-status)
# live in skills/.orager/skills/ relative to this repo.
ORAGER_SKILLS_DEST="$ADAPTER_DEST/skills/.orager/skills"
mkdir -p "$ORAGER_SKILLS_DEST"
if [[ -d "$SCRIPT_DIR/skills/.orager/skills" ]]; then
  cp -r "$SCRIPT_DIR/skills/.orager/skills/"* "$ORAGER_SKILLS_DEST/" 2>/dev/null || true
  echo "→ Copied orager exec skills to $ORAGER_SKILLS_DEST"
fi

# Copy skills from the claude-local adapter so orager gets the same Paperclip
# procedural knowledge without us having to re-teach it.
# Skills are uniquely named, so we skip any that already exist in the destination.
# To force a refresh of a skill, delete its directory and re-run install.sh.
CLAUDE_LOCAL_SKILLS=""
for candidate in \
  "$ADAPTER_MODULES/adapter-claude-local/skills" \
  "$NODE_MODULES_ROOT/@paperclipai/adapter-claude-local/skills" \
  "$PAPERCLIP_ROOT/node_modules/@paperclipai/adapter-claude-local/skills"; do
  if [[ -d "$candidate" ]]; then
    CLAUDE_LOCAL_SKILLS="$candidate"
    break
  fi
done

if [[ -n "$CLAUDE_LOCAL_SKILLS" ]]; then
  echo "→ Syncing claude-local skills from $CLAUDE_LOCAL_SKILLS ..."
  for skill_dir in "$CLAUDE_LOCAL_SKILLS"/*/; do
    skill_name=$(basename "$skill_dir")
    dest_skill="$ORAGER_SKILLS_DEST/$skill_name"
    if [[ -d "$dest_skill" ]]; then
      echo "  ✓ $skill_name (already exists — skipping)"
      continue
    fi
    mkdir -p "$dest_skill"
    cp -r "${skill_dir}." "$dest_skill/" 2>/dev/null || cp -r "$skill_dir"* "$dest_skill/" 2>/dev/null || true
    echo "  ✓ $skill_name (copied)"
  done
else
  echo "  ⚠ claude-local adapter not found — skipping (orager exec skills still installed)"
fi

# ── 2. Patch Zod adapterType enum in @paperclipai/shared ─────────────────────
# Patch ALL copies of constants.js — the server and its nested shared package
# may each have their own copy, and only the one the server process imports matters.
PATCHED_ANY_CONSTANTS=0
for candidate in \
  "$NODE_MODULES_ROOT/@paperclipai/shared/dist/constants.js" \
  "$NODE_MODULES_ROOT/@paperclipai/server/node_modules/@paperclipai/shared/dist/constants.js" \
  "$PAPERCLIP_ROOT/node_modules/@paperclipai/shared/dist/constants.js" \
  "$PAPERCLIP_ROOT/node_modules/@paperclipai/server/node_modules/@paperclipai/shared/dist/constants.js"; do
  if [[ ! -f "$candidate" ]]; then continue; fi
  echo "→ Patching AGENT_ADAPTER_TYPES: $candidate ..."
  node - "$candidate" <<'NODE_SCRIPT'
const fs = require("fs");
const file = process.argv[2];
let src = fs.readFileSync(file, "utf8");

if (src.includes('"openrouter"')) {
  console.log("  (already contains openrouter — skipping)");
  process.exit(0);
}

const patched = src.replace(
  '    "hermes_local",\n];',
  '    "hermes_local",\n    "openrouter",\n];'
);

if (patched === src) {
  console.log("  ⚠ Could not find AGENT_ADAPTER_TYPES array — skipping.");
  process.exit(0);
}

fs.writeFileSync(file, patched, "utf8");
console.log("  Done.");
NODE_SCRIPT
  PATCHED_ANY_CONSTANTS=1
done

if [[ "$PATCHED_ANY_CONSTANTS" -eq 0 ]]; then
  echo "⚠  @paperclipai/shared constants not found — adapter type may be rejected by server."
fi

# ── 3. Find and patch server registry ────────────────────────────────────────
SERVER_REGISTRY=""

for candidate in \
  "$NODE_MODULES_ROOT/@paperclipai/server/dist/adapters/registry.js" \
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
  let changed = false;
  if (src.includes("supportsLocalAgentJwt: false")) {
    src = src.replace("supportsLocalAgentJwt: false", "supportsLocalAgentJwt: true");
    changed = true;
    console.log("  (updated supportsLocalAgentJwt: false → true)");
  }
  if (!src.includes("listOpenRouterSkills")) {
    src = src.replace(
      "listOpenRouterModels,\n} from \"@paperclipai/adapter-openrouter/server\";",
      "listOpenRouterModels,\n  listOpenRouterSkills,\n  syncOpenRouterSkills,\n} from \"@paperclipai/adapter-openrouter/server\";"
    );
    src = src.replace(
      "listModels: listOpenRouterModels,",
      "listModels: listOpenRouterModels,\n  listSkills: listOpenRouterSkills,\n  syncSkills: syncOpenRouterSkills,"
    );
    changed = true;
    console.log("  (added listSkills/syncSkills)");
  }
  if (!changed) console.log("  (server registry already up to date — skipping)");
  if (changed) fs.writeFileSync(file, src, "utf8");
  process.exit(0);
}

const serverImport = `import {
  execute as openrouterExecute,
  testEnvironment as openrouterTestEnvironment,
  sessionCodec as openrouterSessionCodec,
  listOpenRouterModels,
  listOpenRouterSkills,
  syncOpenRouterSkills,
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
  listModels: listOpenRouterModels,
  listSkills: listOpenRouterSkills,
  syncSkills: syncOpenRouterSkills,
  supportsLocalAgentJwt: true,
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

# ── 3. Deploy pre-built UI ────────────────────────────────────────────────────
# Replace the installed ui-dist with our pre-built bundle that has the
# OpenRouter adapter wired into the adapter registry, model dropdown, and
# config form.  This avoids fragile minified-bundle patching entirely.
UI_PREBUILT="$SCRIPT_DIR/ui-dist"
UI_SERVER_DIST="$NODE_MODULES_ROOT/@paperclipai/server/ui-dist"

if [[ ! -d "$UI_PREBUILT" ]]; then
  echo "⚠  Pre-built UI not found at $UI_PREBUILT — skipping UI deployment."
  echo "   OpenRouter will appear in the adapter list but the model dropdown may not show."
elif [[ -f "$UI_SERVER_DIST/index.html" ]] && diff -rq "$UI_PREBUILT" "$UI_SERVER_DIST" >/dev/null 2>&1; then
  echo "→ UI already up to date — skipping."
else
  echo "→ Deploying pre-built UI to $UI_SERVER_DIST ..."
  rm -rf "$UI_SERVER_DIST"
  cp -r "$UI_PREBUILT" "$UI_SERVER_DIST"
  echo "  Done."
fi

# ── 5. Ensure PAPERCLIP_AGENT_JWT_SECRET is set ──────────────────────────────
# The JWT secret is required for adapters to receive PAPERCLIP_API_KEY so they
# can call the Paperclip API. Without it, server-side task pre-fetching won't work.
PAPERCLIP_INSTANCE_DIR="$HOME/.paperclip/instances/default"
PAPERCLIP_ENV_FILE="$PAPERCLIP_INSTANCE_DIR/.env"

mkdir -p "$PAPERCLIP_INSTANCE_DIR"

if [[ -f "$PAPERCLIP_ENV_FILE" ]] && grep -q "PAPERCLIP_AGENT_JWT_SECRET" "$PAPERCLIP_ENV_FILE" 2>/dev/null; then
  echo "→ PAPERCLIP_AGENT_JWT_SECRET already set in $PAPERCLIP_ENV_FILE — skipping."
else
  echo "→ Generating PAPERCLIP_AGENT_JWT_SECRET in $PAPERCLIP_ENV_FILE ..."
  JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  if [[ -f "$PAPERCLIP_ENV_FILE" ]]; then
    echo "PAPERCLIP_AGENT_JWT_SECRET=$JWT_SECRET" >> "$PAPERCLIP_ENV_FILE"
  else
    printf "# Paperclip environment variables\n# Generated by paperclip-openrouter-adapter install.sh\nPAPERCLIP_AGENT_JWT_SECRET=%s\n" "$JWT_SECRET" > "$PAPERCLIP_ENV_FILE"
  fi
  echo "  Done."
fi

# ── 6. Build and reinstall orager ────────────────────────────────────────────
# If the orager source repo exists locally, rebuild and reinstall the global
# binary so changes to the MCP server, session pruning, etc. take effect.
# On the remote Mac Mini this keeps orager in sync whenever install.sh is run.
ORAGER_REPO="$HOME/Projects/orager"

if [[ -d "$ORAGER_REPO" ]]; then
  echo "→ Found orager repo at $ORAGER_REPO — rebuilding ..."

  # Pull latest changes (fail silently if not a git repo or no remote)
  if [[ -d "$ORAGER_REPO/.git" ]]; then
    git -C "$ORAGER_REPO" pull --ff-only 2>&1 | sed 's/^/  /' || echo "  ⚠ git pull failed — using current state"
  fi

  # Install deps (picks up new packages like @modelcontextprotocol/sdk)
  (cd "$ORAGER_REPO" && npm install --silent 2>&1 | tail -3 | sed 's/^/  /')

  # Build TypeScript
  if (cd "$ORAGER_REPO" && node node_modules/typescript/bin/tsc 2>&1 | sed 's/^/  /'); then
    echo "  Build ok."
  else
    echo "  ⚠ orager build had errors — check output above."
  fi

  # Reinstall global binary (orager + orager-mcp)
  (cd "$ORAGER_REPO" && npm install -g . --silent 2>&1 | sed 's/^/  /') || \
    (cd "$ORAGER_REPO" && sudo npm install -g . 2>&1 | sed 's/^/  /')
  echo "  ✓ orager reinstalled globally."
elif command -v orager &>/dev/null; then
  echo "→ orager found on PATH at $(command -v orager) — skipping rebuild."
  echo "  (clone ~/Projects/orager to enable auto-rebuild)"
else
  echo "⚠  orager not found. Install it manually:"
  echo "   git clone <orager-repo-url> ~/Projects/orager"
  echo "   cd ~/Projects/orager && npm install && npm run build && npm install -g ."
fi

echo ""
echo "✓ OpenRouter adapter installed."
echo ""
echo "  Restart paperclipai, then create or edit an agent and select"
echo "  'OpenRouter (orager)' as the adapter type."
echo ""
echo "  API key: set OPENROUTER_API_KEY env var before starting paperclipai"
