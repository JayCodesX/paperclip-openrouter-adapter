import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Stored on disk as ~/.orager/memory/<agentId>.json */
export interface MemoryStore {
  agentId: string;
  entries: MemoryEntry[];
  updatedAt: string; // ISO
}

export interface MemoryEntry {
  id: string;           // crypto.randomUUID()
  content: string;      // freeform text, agent-authored
  tags?: string[];      // optional: ["bug", "auth", "user-pref"]
  createdAt: string;    // ISO
  expiresAt?: string;   // ISO — undefined means never
  runId?: string;       // which run created it
  importance: 1 | 2 | 3; // 1=low, 2=normal, 3=high (affects sort order)
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function sanitizeAgentId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

function memoryFilePath(agentId: string): string {
  const sanitized = sanitizeAgentId(agentId);
  return path.join(os.homedir(), ".orager", "memory", `${sanitized}.json`);
}

// ── Storage ───────────────────────────────────────────────────────────────────

export async function loadMemoryStore(agentId: string): Promise<MemoryStore> {
  const filePath = memoryFilePath(agentId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as MemoryStore;
  } catch {
    // ENOENT or JSON parse error → return empty store (not an error)
    return { agentId, entries: [], updatedAt: new Date().toISOString() };
  }
}

export async function saveMemoryStore(agentId: string, store: MemoryStore): Promise<void> {
  const filePath = memoryFilePath(agentId);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns live (non-expired) entries sorted by importance desc, createdAt desc.
 * Truncates to maxChars to enforce token budget. Returns empty string when no entries.
 *
 * Format:
 *   [1] (id: abc123, importance: 3, tags: auth) Auth tokens expire after 1h
 *   [2] (id: def456, importance: 2) User prefers TypeScript
 */
export function renderMemoryBlock(store: MemoryStore, maxChars = 6000): string {
  if (store.entries.length === 0) return "";

  // Sort by importance desc, then createdAt desc
  const sorted = [...store.entries].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.createdAt.localeCompare(a.createdAt);
  });

  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const tagPart = e.tags && e.tags.length > 0 ? `, tags: ${e.tags.join(", ")}` : "";
    lines.push(`[${i + 1}] (id: ${e.id}, importance: ${e.importance}${tagPart}) ${e.content}`);
  }

  let result = lines.join("\n");
  if (result.length <= maxChars) return result;

  // Truncate at maxChars without leaking a partial entry
  const truncated = result.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  return lastNewline > 0 ? truncated.slice(0, lastNewline) : "";
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Adds an entry. Immutable — returns a new store; original is unchanged. */
export function addMemoryEntry(
  store: MemoryStore,
  entry: Omit<MemoryEntry, "id" | "createdAt">,
): MemoryStore {
  const now = new Date().toISOString();
  const newEntry: MemoryEntry = {
    ...entry,
    importance: entry.importance ?? 2,
    id: crypto.randomUUID(),
    createdAt: now,
  };
  return {
    ...store,
    entries: [...store.entries, newEntry],
    updatedAt: now,
  };
}

/** Removes an entry by id. No-ops when id doesn't exist. Immutable. */
export function removeMemoryEntry(store: MemoryStore, id: string): MemoryStore {
  const entries = store.entries.filter((e) => e.id !== id);
  if (entries.length === store.entries.length) return store;
  return { ...store, entries, updatedAt: new Date().toISOString() };
}

// ── Maintenance ───────────────────────────────────────────────────────────────

/** Prunes expired entries. Immutable — returns a new store. */
export function pruneExpired(store: MemoryStore): MemoryStore {
  // N-11: Compare timestamps numerically instead of lexicographically.
  // ISO 8601 strings with different timezone offset formats (+00:00 vs Z)
  // produce incorrect results with string comparison.
  const nowMs = Date.now();
  const entries = store.entries.filter(
    (e) => !e.expiresAt || new Date(e.expiresAt).getTime() > nowMs,
  );
  if (entries.length === store.entries.length) return store;
  return { ...store, entries, updatedAt: new Date().toISOString() };
}

// ── Skill result handler ──────────────────────────────────────────────────────

/**
 * Applies a `remember` skill tool call result to the store.
 *
 * Orager emits tool results as JSON events; the skill returns:
 *   { action: "add", content: string, tags?: string[], ttlDays?: number, importance?: 1|2|3 }
 * | { action: "remove", id: string }
 * | { action: "list" }  ← no write, returns current entries as listOutput
 *
 * Unknown or malformed results are silently ignored (never throws).
 */
export function applySkillResult(
  store: MemoryStore,
  result: Record<string, unknown>,
  runId: string,
): { store: MemoryStore; listOutput?: string } {
  const action = typeof result.action === "string" ? result.action : null;
  if (!action) return { store };

  if (action === "add") {
    const content = typeof result.content === "string" ? result.content.slice(0, 500) : null;
    if (!content) return { store };

    const tags = Array.isArray(result.tags)
      ? result.tags.filter((t): t is string => typeof t === "string")
      : undefined;

    const ttlDays =
      typeof result.ttlDays === "number" && Number.isFinite(result.ttlDays)
        ? result.ttlDays
        : undefined;

    const rawImportance = result.importance;
    const importance: 1 | 2 | 3 =
      rawImportance === 1 || rawImportance === 2 || rawImportance === 3
        ? rawImportance
        : 2;

    const expiresAt =
      ttlDays !== undefined
        ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

    return {
      store: addMemoryEntry(store, {
        content,
        ...(tags ? { tags } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        importance,
        runId,
      }),
    };
  }

  if (action === "remove") {
    const id = typeof result.id === "string" ? result.id : null;
    if (!id) return { store };
    return { store: removeMemoryEntry(store, id) };
  }

  if (action === "list") {
    return { store, listOutput: renderMemoryBlock(store) };
  }

  // Unknown action — return unchanged
  return { store };
}
