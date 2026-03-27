import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
// ── Path helpers ──────────────────────────────────────────────────────────────
function sanitizeAgentId(agentId) {
    return agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}
function memoryFilePath(agentId) {
    const sanitized = sanitizeAgentId(agentId);
    return path.join(os.homedir(), ".orager", "memory", `${sanitized}.json`);
}
// ── Storage ───────────────────────────────────────────────────────────────────
export async function loadMemoryStore(agentId) {
    const filePath = memoryFilePath(agentId);
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        // ENOENT or JSON parse error → return empty store (not an error)
        return { agentId, entries: [], updatedAt: new Date().toISOString() };
    }
}
export async function saveMemoryStore(agentId, store) {
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
export function renderMemoryBlock(store, maxChars = 6000) {
    if (store.entries.length === 0)
        return "";
    // Sort by importance desc, then createdAt desc
    const sorted = [...store.entries].sort((a, b) => {
        if (b.importance !== a.importance)
            return b.importance - a.importance;
        return b.createdAt.localeCompare(a.createdAt);
    });
    const lines = [];
    for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i];
        const tagPart = e.tags && e.tags.length > 0 ? `, tags: ${e.tags.join(", ")}` : "";
        lines.push(`[${i + 1}] (id: ${e.id}, importance: ${e.importance}${tagPart}) ${e.content}`);
    }
    let result = lines.join("\n");
    if (result.length <= maxChars)
        return result;
    // Truncate at maxChars without leaking a partial entry
    const truncated = result.slice(0, maxChars);
    const lastNewline = truncated.lastIndexOf("\n");
    return lastNewline > 0 ? truncated.slice(0, lastNewline) : "";
}
// ── Writes ────────────────────────────────────────────────────────────────────
/** Adds an entry. Immutable — returns a new store; original is unchanged. */
export function addMemoryEntry(store, entry) {
    const now = new Date().toISOString();
    const newEntry = {
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
export function removeMemoryEntry(store, id) {
    const entries = store.entries.filter((e) => e.id !== id);
    if (entries.length === store.entries.length)
        return store;
    return { ...store, entries, updatedAt: new Date().toISOString() };
}
// ── Maintenance ───────────────────────────────────────────────────────────────
/** Prunes expired entries. Immutable — returns a new store. */
export function pruneExpired(store) {
    const now = new Date().toISOString();
    const entries = store.entries.filter((e) => !e.expiresAt || e.expiresAt > now);
    if (entries.length === store.entries.length)
        return store;
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
export function applySkillResult(store, result, runId) {
    const action = typeof result.action === "string" ? result.action : null;
    if (!action)
        return { store };
    if (action === "add") {
        const content = typeof result.content === "string" ? result.content.slice(0, 500) : null;
        if (!content)
            return { store };
        const tags = Array.isArray(result.tags)
            ? result.tags.filter((t) => typeof t === "string")
            : undefined;
        const ttlDays = typeof result.ttlDays === "number" && Number.isFinite(result.ttlDays)
            ? result.ttlDays
            : undefined;
        const rawImportance = result.importance;
        const importance = rawImportance === 1 || rawImportance === 2 || rawImportance === 3
            ? rawImportance
            : 2;
        const expiresAt = ttlDays !== undefined
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
        if (!id)
            return { store };
        return { store: removeMemoryEntry(store, id) };
    }
    if (action === "list") {
        return { store, listOutput: renderMemoryBlock(store) };
    }
    // Unknown action — return unchanged
    return { store };
}
//# sourceMappingURL=memory.js.map