/**
 * Skills support for the orager adapter.
 *
 * Uses the "ephemeral" pattern (same as claude_local):
 * - `buildOragerSkillsDir()` creates a per-run temp directory and symlinks
 *   every desired Paperclip skill into it.
 * - The temp dir path is passed to orager as an `addDirs` entry so the skills
 *   are discovered as registered tools on each run.
 * - The caller is responsible for cleaning up the temp dir after the run.
 *
 * Falls back gracefully when no Paperclip skills directory is found —
 * the run continues with the bundled static skills only.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listPaperclipSkillEntries,
  ensurePaperclipSkillSymlink,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface OragerSkillsDir {
  /** Absolute path to the ephemeral skills temp directory. */
  dir: string;
  /** Names of skills that were successfully symlinked. */
  linked: string[];
  /** Skill names that were desired but not found in the Paperclip skills dir. */
  missing: string[];
}

/**
 * Create an ephemeral temp directory populated with symlinks to the desired
 * Paperclip skills, suitable for passing to orager as an `addDirs` entry.
 *
 * @param desiredSkills - Skill names requested by Paperclip (empty = all available).
 * @returns OragerSkillsDir — dir path + linked/missing lists.
 *          Returns null if no Paperclip skills directory is found (non-fatal).
 */
export async function buildOragerSkillsDir(
  desiredSkills: string[],
): Promise<OragerSkillsDir | null> {
  const available = await listPaperclipSkillEntries(__moduleDir);
  if (available.length === 0) return null;

  // When caller passes an empty desired list, link all available skills.
  const desiredSet = desiredSkills.length > 0
    ? new Set(desiredSkills.map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null; // null = link all

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-orager-skills-"));
  const linked: string[] = [];
  const missing: string[] = [];

  for (const entry of available) {
    if (desiredSet !== null && !desiredSet.has(entry.name.toLowerCase())) continue;
    const target = path.join(tmp, entry.name);
    try {
      await ensurePaperclipSkillSymlink(entry.source, target);
      linked.push(entry.name);
    } catch {
      // Non-fatal — log as missing rather than crashing the run
      missing.push(entry.name);
    }
  }

  // Track which desired skills had no matching entry at all
  if (desiredSet !== null) {
    for (const desired of desiredSet) {
      if (!available.some((e) => e.name.toLowerCase() === desired) && !missing.includes(desired)) {
        missing.push(desired);
      }
    }
  }

  return { dir: tmp, linked, missing };
}

/**
 * Remove the ephemeral skills temp directory created by buildOragerSkillsDir.
 * Non-fatal — errors are swallowed so cleanup never crashes a run.
 */
export async function cleanupOragerSkillsDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ── Paperclip skills API ──────────────────────────────────────────────────────

const SNAPSHOT_BASE = {
  adapterType: "openrouter",
  supported: true,
  mode: "ephemeral" as const,
  warnings: [] as string[],
};

export async function listOpenRouterSkills(_ctx: unknown): Promise<typeof SNAPSHOT_BASE & { desiredSkills: string[]; entries: string[] }> {
  const available = await listPaperclipSkillEntries(__moduleDir);
  return {
    ...SNAPSHOT_BASE,
    desiredSkills: [],
    entries: available.map((e) => e.name),
  };
}

export async function syncOpenRouterSkills(
  _ctx: unknown,
  desiredSkills: string[],
): Promise<typeof SNAPSHOT_BASE & { desiredSkills: string[]; entries: string[] }> {
  const available = await listPaperclipSkillEntries(__moduleDir);
  const warnings: string[] = [];
  const valid = desiredSkills.filter((s) => typeof s === "string" && s.trim());
  const availableNames = new Set(available.map((e) => e.name.toLowerCase()));
  for (const s of valid) {
    if (!availableNames.has(s.trim().toLowerCase())) {
      warnings.push(`Desired skill "${s}" is not available in the Paperclip skills directory.`);
    }
  }
  return {
    ...SNAPSHOT_BASE,
    desiredSkills: valid,
    entries: available.map((e) => e.name),
    warnings,
  };
}
