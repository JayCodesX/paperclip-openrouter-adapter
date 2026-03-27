/** Stored on disk as ~/.orager/memory/<agentId>.json */
export interface MemoryStore {
    agentId: string;
    entries: MemoryEntry[];
    updatedAt: string;
}
export interface MemoryEntry {
    id: string;
    content: string;
    tags?: string[];
    createdAt: string;
    expiresAt?: string;
    runId?: string;
    importance: 1 | 2 | 3;
}
export declare function loadMemoryStore(agentId: string): Promise<MemoryStore>;
export declare function saveMemoryStore(agentId: string, store: MemoryStore): Promise<void>;
/**
 * Returns live (non-expired) entries sorted by importance desc, createdAt desc.
 * Truncates to maxChars to enforce token budget. Returns empty string when no entries.
 *
 * Format:
 *   [1] (id: abc123, importance: 3, tags: auth) Auth tokens expire after 1h
 *   [2] (id: def456, importance: 2) User prefers TypeScript
 */
export declare function renderMemoryBlock(store: MemoryStore, maxChars?: number): string;
/** Adds an entry. Immutable — returns a new store; original is unchanged. */
export declare function addMemoryEntry(store: MemoryStore, entry: Omit<MemoryEntry, "id" | "createdAt">): MemoryStore;
/** Removes an entry by id. No-ops when id doesn't exist. Immutable. */
export declare function removeMemoryEntry(store: MemoryStore, id: string): MemoryStore;
/** Prunes expired entries. Immutable — returns a new store. */
export declare function pruneExpired(store: MemoryStore): MemoryStore;
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
export declare function applySkillResult(store: MemoryStore, result: Record<string, unknown>, runId: string): {
    store: MemoryStore;
    listOutput?: string;
};
//# sourceMappingURL=memory.d.ts.map