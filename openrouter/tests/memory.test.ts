/**
 * Unit tests for memory.ts — renderMemoryBlock, addMemoryEntry,
 * removeMemoryEntry, pruneExpired, and applySkillResult.
 *
 * saveMemoryStore / loadMemoryStore are I/O functions; they're covered
 * implicitly via integration tests rather than unit-tested here.
 */
import { describe, it, expect } from "vitest";
import {
  renderMemoryBlock,
  addMemoryEntry,
  removeMemoryEntry,
  pruneExpired,
  applySkillResult,
  type MemoryStore,
  type MemoryEntry,
} from "../src/server/memory.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeStore(entries: Partial<MemoryEntry>[] = []): MemoryStore {
  const base: MemoryStore = {
    agentId: "test-agent",
    entries: [],
    updatedAt: new Date().toISOString(),
  };
  let store = base;
  for (const e of entries) {
    store = addMemoryEntry(store, {
      content: e.content ?? "default content",
      importance: e.importance ?? 2,
      ...(e.tags ? { tags: e.tags } : {}),
      ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
      ...(e.runId ? { runId: e.runId } : {}),
    });
  }
  return store;
}

// ── renderMemoryBlock ─────────────────────────────────────────────────────────

describe("renderMemoryBlock", () => {
  it("returns empty string for empty store", () => {
    const store = makeStore([]);
    expect(renderMemoryBlock(store)).toBe("");
  });

  it("formats a single entry correctly", () => {
    const store = makeStore([{ content: "remember this", importance: 2 }]);
    const output = renderMemoryBlock(store);
    expect(output).toContain("remember this");
    expect(output).toContain("importance: 2");
  });

  it("sorts higher importance entries first", () => {
    const store = makeStore([
      { content: "low", importance: 1 },
      { content: "high", importance: 3 },
      { content: "medium", importance: 2 },
    ]);
    const output = renderMemoryBlock(store);
    const highIdx = output.indexOf("high");
    const medIdx = output.indexOf("medium");
    const lowIdx = output.indexOf("low");
    expect(highIdx).toBeLessThan(medIdx);
    expect(medIdx).toBeLessThan(lowIdx);
  });

  it("includes tags when present", () => {
    const store = makeStore([{ content: "tagged entry", tags: ["auth", "security"], importance: 2 }]);
    const output = renderMemoryBlock(store);
    expect(output).toContain("tags: auth, security");
  });

  it("truncates output at maxChars boundary without splitting mid-entry", () => {
    // Create many entries totalling well over 100 chars
    const store = makeStore(Array.from({ length: 20 }, (_, i) => ({
      content: `entry-${String(i).padStart(3, "0")} with some content to make it longer`,
      importance: 2,
    })));
    const output = renderMemoryBlock(store, 100);
    expect(output.length).toBeLessThanOrEqual(100);
    // Should not end mid-line
    expect(output.endsWith("\n")).toBe(false);
  });
});

// ── addMemoryEntry ────────────────────────────────────────────────────────────

describe("addMemoryEntry", () => {
  it("adds an entry to the store", () => {
    const store = makeStore([]);
    const updated = addMemoryEntry(store, { content: "new entry", importance: 2 });
    expect(updated.entries).toHaveLength(1);
    expect(updated.entries[0].content).toBe("new entry");
  });

  it("assigns a UUID id", () => {
    const store = makeStore([]);
    const updated = addMemoryEntry(store, { content: "x", importance: 2 });
    expect(typeof updated.entries[0].id).toBe("string");
    expect(updated.entries[0].id.length).toBeGreaterThan(0);
  });

  it("does not mutate the original store", () => {
    const store = makeStore([]);
    addMemoryEntry(store, { content: "x", importance: 2 });
    expect(store.entries).toHaveLength(0);
  });
});

// ── removeMemoryEntry ─────────────────────────────────────────────────────────

describe("removeMemoryEntry", () => {
  it("removes the entry with the given id", () => {
    const store = makeStore([{ content: "to remove", importance: 2 }]);
    const id = store.entries[0].id;
    const updated = removeMemoryEntry(store, id);
    expect(updated.entries).toHaveLength(0);
  });

  it("is a no-op when id does not exist", () => {
    const store = makeStore([{ content: "keep me", importance: 2 }]);
    const updated = removeMemoryEntry(store, "nonexistent-id");
    expect(updated).toBe(store); // reference equality — no new object
  });

  it("does not mutate the original store", () => {
    const store = makeStore([{ content: "x", importance: 2 }]);
    const id = store.entries[0].id;
    removeMemoryEntry(store, id);
    expect(store.entries).toHaveLength(1);
  });
});

// ── pruneExpired ──────────────────────────────────────────────────────────────

describe("pruneExpired", () => {
  it("removes entries whose expiresAt is in the past", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const store = makeStore([{ content: "expired", expiresAt: past, importance: 2 }]);
    const pruned = pruneExpired(store);
    expect(pruned.entries).toHaveLength(0);
  });

  it("keeps entries whose expiresAt is in the future", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const store = makeStore([{ content: "active", expiresAt: future, importance: 2 }]);
    const pruned = pruneExpired(store);
    expect(pruned.entries).toHaveLength(1);
  });

  it("keeps entries with no expiresAt (never-expire)", () => {
    const store = makeStore([{ content: "permanent", importance: 2 }]);
    const pruned = pruneExpired(store);
    expect(pruned.entries).toHaveLength(1);
  });

  it("returns original store reference when nothing changes", () => {
    const store = makeStore([{ content: "permanent", importance: 2 }]);
    const pruned = pruneExpired(store);
    expect(pruned).toBe(store);
  });

  // N-11: Timezone-safe date comparison tests
  it("N-11: correctly prunes expired entries with +00:00 timezone format", () => {
    const past = new Date(Date.now() - 10_000).toISOString().replace("Z", "+00:00");
    const store = makeStore([{ content: "expired-tz", expiresAt: past, importance: 2 }]);
    const pruned = pruneExpired(store);
    expect(pruned.entries).toHaveLength(0);
  });

  it("N-11: correctly keeps future entries regardless of timezone format", () => {
    // Use a future date with explicit +00:00 offset instead of Z
    const future = new Date(Date.now() + 60_000).toISOString().replace("Z", "+00:00");
    const store = makeStore([{ content: "future-tz", expiresAt: future, importance: 2 }]);
    const pruned = pruneExpired(store);
    expect(pruned.entries).toHaveLength(1);
  });
});

// ── applySkillResult ──────────────────────────────────────────────────────────

describe("applySkillResult", () => {
  it("adds an entry for action=add", () => {
    const store = makeStore([]);
    const { store: updated } = applySkillResult(
      store,
      { action: "add", content: "skill result content", importance: 3 },
      "run-1",
    );
    expect(updated.entries).toHaveLength(1);
    expect(updated.entries[0].content).toBe("skill result content");
    expect(updated.entries[0].importance).toBe(3);
    expect(updated.entries[0].runId).toBe("run-1");
  });

  it("removes an entry for action=remove", () => {
    const store = makeStore([{ content: "to remove", importance: 2 }]);
    const id = store.entries[0].id;
    const { store: updated } = applySkillResult(store, { action: "remove", id }, "run-1");
    expect(updated.entries).toHaveLength(0);
  });

  it("returns listOutput for action=list", () => {
    const store = makeStore([{ content: "list me", importance: 2 }]);
    const { store: unchanged, listOutput } = applySkillResult(store, { action: "list" }, "run-1");
    expect(unchanged).toBe(store);
    expect(typeof listOutput).toBe("string");
    expect(listOutput).toContain("list me");
  });

  it("returns unchanged store for unknown action", () => {
    const store = makeStore([]);
    const { store: unchanged } = applySkillResult(store, { action: "unknown_action" }, "run-1");
    expect(unchanged).toBe(store);
  });

  it("returns unchanged store for missing action field", () => {
    const store = makeStore([]);
    const { store: unchanged } = applySkillResult(store, { data: "no action" }, "run-1");
    expect(unchanged).toBe(store);
  });

  it("ignores add with missing content", () => {
    const store = makeStore([]);
    const { store: unchanged } = applySkillResult(store, { action: "add" }, "run-1");
    expect(unchanged).toBe(store);
  });

  it("truncates content to 500 chars", () => {
    const store = makeStore([]);
    const longContent = "a".repeat(600);
    const { store: updated } = applySkillResult(
      store,
      { action: "add", content: longContent, importance: 2 },
      "run-1",
    );
    expect(updated.entries[0].content.length).toBeLessThanOrEqual(500);
  });
});
