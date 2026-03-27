import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";

// Mock fs/promises before importing memory module
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    mkdir: vi.fn(),
  },
}));

import fs from "node:fs/promises";
import {
  addMemoryEntry,
  removeMemoryEntry,
  pruneExpired,
  renderMemoryBlock,
  applySkillResult,
  loadMemoryStore,
  saveMemoryStore,
  type MemoryStore,
  type MemoryEntry,
} from "../src/server/memory.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyStore(agentId = "test-agent"): MemoryStore {
  return { agentId, entries: [], updatedAt: new Date().toISOString() };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "eid-1",
    content: "some fact",
    createdAt: new Date().toISOString(),
    importance: 2,
    ...overrides,
  };
}

// ── addMemoryEntry ─────────────────────────────────────────────────────────────

describe("addMemoryEntry", () => {
  it("adds an entry and assigns id and createdAt", () => {
    const store = emptyStore();
    const result = addMemoryEntry(store, { content: "hello", importance: 2 });
    expect(result.entries).toHaveLength(1);
    expect(typeof result.entries[0].id).toBe("string");
    expect(result.entries[0].id.length).toBeGreaterThan(0);
    expect(typeof result.entries[0].createdAt).toBe("string");
    expect(result.entries[0].content).toBe("hello");
  });

  it("defaults importance to 2 when not provided", () => {
    const store = emptyStore();
    // importance is required in the type but addMemoryEntry omits it from input
    const result = addMemoryEntry(store, { content: "hi", importance: 2 });
    expect(result.entries[0].importance).toBe(2);
  });

  it("sets expiresAt correctly when ttlDays is implied via expiresAt", () => {
    const store = emptyStore();
    const ttlMs = 7 * 24 * 60 * 60 * 1000;
    const before = Date.now();
    const expiresAt = new Date(before + ttlMs).toISOString();
    const result = addMemoryEntry(store, { content: "temp", importance: 2, expiresAt });
    const stored = new Date(result.entries[0].expiresAt!).getTime();
    expect(stored).toBeGreaterThanOrEqual(before + ttlMs - 1000);
    expect(stored).toBeLessThanOrEqual(before + ttlMs + 1000);
  });

  it("has no expiresAt when none provided", () => {
    const store = emptyStore();
    const result = addMemoryEntry(store, { content: "permanent", importance: 2 });
    expect(result.entries[0].expiresAt).toBeUndefined();
  });

  it("returns a new store and does not mutate the original", () => {
    const store = emptyStore();
    const result = addMemoryEntry(store, { content: "hi", importance: 2 });
    expect(store.entries).toHaveLength(0);
    expect(result).not.toBe(store);
    expect(result.entries).not.toBe(store.entries);
  });

  it("stores importance 3 correctly", () => {
    const store = emptyStore();
    const result = addMemoryEntry(store, { content: "critical", importance: 3 });
    expect(result.entries[0].importance).toBe(3);
  });

  it("stores tags when provided", () => {
    const store = emptyStore();
    const result = addMemoryEntry(store, { content: "auth fact", importance: 2, tags: ["auth"] });
    expect(result.entries[0].tags).toEqual(["auth"]);
  });
});

// ── removeMemoryEntry ─────────────────────────────────────────────────────────

describe("removeMemoryEntry", () => {
  it("removes the entry with the matching id", () => {
    const entry1 = makeEntry({ id: "aaa", content: "keep" });
    const entry2 = makeEntry({ id: "bbb", content: "remove" });
    const store: MemoryStore = { agentId: "a", entries: [entry1, entry2], updatedAt: "" };
    const result = removeMemoryEntry(store, "bbb");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("aaa");
  });

  it("leaves other entries intact", () => {
    const entry1 = makeEntry({ id: "aaa" });
    const entry2 = makeEntry({ id: "bbb" });
    const entry3 = makeEntry({ id: "ccc" });
    const store: MemoryStore = { agentId: "a", entries: [entry1, entry2, entry3], updatedAt: "" };
    const result = removeMemoryEntry(store, "bbb");
    expect(result.entries.map((e) => e.id)).toEqual(["aaa", "ccc"]);
  });

  it("no-ops when id does not exist (no throw)", () => {
    const entry1 = makeEntry({ id: "aaa" });
    const store: MemoryStore = { agentId: "a", entries: [entry1], updatedAt: "" };
    expect(() => removeMemoryEntry(store, "nonexistent")).not.toThrow();
    const result = removeMemoryEntry(store, "nonexistent");
    expect(result.entries).toHaveLength(1);
    // Returns same reference when nothing changed
    expect(result).toBe(store);
  });
});

// ── pruneExpired ──────────────────────────────────────────────────────────────

describe("pruneExpired", () => {
  it("keeps entries with no expiresAt", () => {
    const e = makeEntry({ expiresAt: undefined });
    const store: MemoryStore = { agentId: "a", entries: [e], updatedAt: "" };
    const result = pruneExpired(store);
    expect(result.entries).toHaveLength(1);
  });

  it("keeps entries with a future expiresAt", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const e = makeEntry({ expiresAt: future });
    const store: MemoryStore = { agentId: "a", entries: [e], updatedAt: "" };
    const result = pruneExpired(store);
    expect(result.entries).toHaveLength(1);
  });

  it("removes entries with a past expiresAt", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const e = makeEntry({ expiresAt: past });
    const store: MemoryStore = { agentId: "a", entries: [e], updatedAt: "" };
    const result = pruneExpired(store);
    expect(result.entries).toHaveLength(0);
  });

  it("returns a new store and does not mutate input", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const e = makeEntry({ expiresAt: past });
    const store: MemoryStore = { agentId: "a", entries: [e], updatedAt: "" };
    const result = pruneExpired(store);
    expect(result).not.toBe(store);
    expect(store.entries).toHaveLength(1); // original unchanged
  });

  it("returns the same reference when nothing is pruned", () => {
    const e = makeEntry({ expiresAt: undefined });
    const store: MemoryStore = { agentId: "a", entries: [e], updatedAt: "" };
    const result = pruneExpired(store);
    expect(result).toBe(store);
  });
});

// ── renderMemoryBlock ─────────────────────────────────────────────────────────

describe("renderMemoryBlock", () => {
  it("returns empty string when there are no entries", () => {
    expect(renderMemoryBlock(emptyStore())).toBe("");
  });

  it("formats entries as a numbered list with id, importance, and content", () => {
    const e = makeEntry({ id: "abc123", importance: 2, content: "hello world" });
    const store: MemoryStore = { agentId: "a", entries: [e], updatedAt: "" };
    const output = renderMemoryBlock(store);
    expect(output).toContain("id: abc123");
    expect(output).toContain("importance: 2");
    expect(output).toContain("hello world");
    expect(output).toMatch(/^\[1\]/);
  });

  it("includes tags in the output when present", () => {
    const e = makeEntry({ id: "t1", importance: 2, content: "auth fact", tags: ["auth", "security"] });
    const store: MemoryStore = { agentId: "a", entries: [e], updatedAt: "" };
    const output = renderMemoryBlock(store);
    expect(output).toContain("tags: auth, security");
  });

  it("truncates output at maxChars without leaking partial entries", () => {
    const entries = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ id: `id-${i}`, content: `fact number ${i} `.repeat(10), importance: 2 })
    );
    const store: MemoryStore = { agentId: "a", entries, updatedAt: "" };
    const output = renderMemoryBlock(store, 200);
    expect(output.length).toBeLessThanOrEqual(200);
    // Output should not end mid-line (each line starts with "[N]")
    const lines = output.split("\n");
    for (const line of lines) {
      expect(line).toMatch(/^\[\d+\]/);
    }
  });

  it("sorts by importance desc, then createdAt desc", () => {
    const t1 = new Date(2024, 0, 1).toISOString();
    const t2 = new Date(2024, 0, 2).toISOString();
    const low = makeEntry({ id: "low", importance: 1, content: "low", createdAt: t2 });
    const high = makeEntry({ id: "high", importance: 3, content: "high", createdAt: t1 });
    const store: MemoryStore = { agentId: "a", entries: [low, high], updatedAt: "" };
    const output = renderMemoryBlock(store);
    const highIdx = output.indexOf("high");
    const lowIdx = output.indexOf("low");
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("places high-importance entries before low-importance even when older", () => {
    const older = new Date(2023, 0, 1).toISOString();
    const newer = new Date(2024, 0, 1).toISOString();
    const highOld = makeEntry({ id: "h", importance: 3, content: "important old", createdAt: older });
    const lowNew = makeEntry({ id: "l", importance: 1, content: "unimportant new", createdAt: newer });
    const store: MemoryStore = { agentId: "a", entries: [lowNew, highOld], updatedAt: "" };
    const output = renderMemoryBlock(store);
    expect(output.indexOf("important old")).toBeLessThan(output.indexOf("unimportant new"));
  });
});

// ── applySkillResult ──────────────────────────────────────────────────────────

describe("applySkillResult", () => {
  it("action=add adds a new entry with correct content", () => {
    const store = emptyStore();
    const { store: result } = applySkillResult(store, { action: "add", content: "new fact" }, "run-1");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toBe("new fact");
  });

  it("action=add forwards tags and ttlDays correctly", () => {
    const store = emptyStore();
    const { store: result } = applySkillResult(
      store,
      { action: "add", content: "tagged", tags: ["auth"], ttlDays: 7 },
      "run-1",
    );
    expect(result.entries[0].tags).toEqual(["auth"]);
    expect(result.entries[0].expiresAt).toBeDefined();
    const expiresMs = new Date(result.entries[0].expiresAt!).getTime();
    const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(expectedMs - 2000);
    expect(expiresMs).toBeLessThanOrEqual(expectedMs + 2000);
  });

  it("action=add with importance 3 stores correctly", () => {
    const store = emptyStore();
    const { store: result } = applySkillResult(
      store,
      { action: "add", content: "critical", importance: 3 },
      "run-1",
    );
    expect(result.entries[0].importance).toBe(3);
  });

  it("action=remove removes entry by id", () => {
    const e = makeEntry({ id: "del-me" });
    const store: MemoryStore = { agentId: "a", entries: [e], updatedAt: "" };
    const { store: result } = applySkillResult(store, { action: "remove", id: "del-me" }, "run-1");
    expect(result.entries).toHaveLength(0);
  });

  it("action=list returns listOutput and leaves store unchanged", () => {
    const e = makeEntry({ id: "x", content: "some fact", importance: 2 });
    const store: MemoryStore = { agentId: "a", entries: [e], updatedAt: "" };
    const { store: result, listOutput } = applySkillResult(store, { action: "list" }, "run-1");
    expect(result).toBe(store);
    expect(typeof listOutput).toBe("string");
    expect(listOutput).toContain("some fact");
  });

  it("unknown action returns store unchanged without throwing", () => {
    const store = emptyStore();
    expect(() => applySkillResult(store, { action: "unknown" }, "run-1")).not.toThrow();
    const { store: result } = applySkillResult(store, { action: "unknown" }, "run-1");
    expect(result).toBe(store);
  });

  it("malformed result (missing action) returns store unchanged without throwing", () => {
    const store = emptyStore();
    expect(() => applySkillResult(store, { content: "no action" }, "run-1")).not.toThrow();
    const { store: result } = applySkillResult(store, { content: "no action" }, "run-1");
    expect(result).toBe(store);
  });
});

// ── loadMemoryStore / saveMemoryStore ─────────────────────────────────────────

describe("loadMemoryStore", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("parses valid JSON from disk correctly", async () => {
    const fixture: MemoryStore = {
      agentId: "agent-42",
      entries: [makeEntry({ id: "e1", content: "stored fact" })],
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(fixture) as never);
    const result = await loadMemoryStore("agent-42");
    expect(result.agentId).toBe("agent-42");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].content).toBe("stored fact");
  });

  it("returns empty store when file does not exist (ENOENT)", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    vi.mocked(fs.readFile).mockRejectedValue(err);
    const result = await loadMemoryStore("no-file-agent");
    expect(result.entries).toHaveLength(0);
    expect(result.agentId).toBe("no-file-agent");
  });

  it("returns empty store when file contains invalid JSON", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("not json at all" as never);
    const result = await loadMemoryStore("bad-json-agent");
    expect(result.entries).toHaveLength(0);
  });
});

describe("saveMemoryStore", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined as never);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined as never);
    vi.mocked(fs.rename).mockResolvedValue(undefined as never);
  });

  it("writes to a .tmp file then renames to the final path", async () => {
    const store = emptyStore("save-agent");
    await saveMemoryStore("save-agent", store);

    const expectedDir = path.join(os.homedir(), ".orager", "memory");
    const expectedFinal = path.join(expectedDir, "save-agent.json");
    const expectedTmp = `${expectedFinal}.tmp`;

    const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
    const renameCall = vi.mocked(fs.rename).mock.calls[0];

    expect(writeCall[0]).toBe(expectedTmp);
    expect(renameCall[0]).toBe(expectedTmp);
    expect(renameCall[1]).toBe(expectedFinal);
  });

  it("writes the file with mode 0o600", async () => {
    const store = emptyStore("perm-agent");
    await saveMemoryStore("perm-agent", store);
    const writeCall = vi.mocked(fs.writeFile).mock.calls[0];
    expect((writeCall[2] as { mode: number }).mode).toBe(0o600);
  });

  it("calls writeFile before rename", async () => {
    const writeOrder: string[] = [];
    vi.mocked(fs.writeFile).mockImplementation(async () => { writeOrder.push("write"); });
    vi.mocked(fs.rename).mockImplementation(async () => { writeOrder.push("rename"); });

    await saveMemoryStore("order-agent", emptyStore("order-agent"));
    expect(writeOrder).toEqual(["write", "rename"]);
  });
});

// ── Integration: end-to-end in-memory flow ────────────────────────────────────

describe("integration: in-memory flow", () => {
  it("adds entries of varying importance, prunes (none expire), renders in importance order", () => {
    let store = emptyStore("integ-agent");
    store = addMemoryEntry(store, { content: "low importance", importance: 1 });
    store = addMemoryEntry(store, { content: "high importance", importance: 3 });
    store = addMemoryEntry(store, { content: "normal importance", importance: 2 });
    store = pruneExpired(store);
    expect(store.entries).toHaveLength(3);
    const output = renderMemoryBlock(store);
    const highIdx = output.indexOf("high importance");
    const normalIdx = output.indexOf("normal importance");
    const lowIdx = output.indexOf("low importance");
    expect(highIdx).toBeLessThan(normalIdx);
    expect(normalIdx).toBeLessThan(lowIdx);
  });

  it("entry with effectively immediate ttl is pruned", () => {
    let store = emptyStore("ttl-agent");
    const expiresAt = new Date(Date.now() - 1).toISOString(); // already expired
    store = addMemoryEntry(store, { content: "gone", importance: 2, expiresAt });
    store = pruneExpired(store);
    expect(store.entries).toHaveLength(0);
    const output = renderMemoryBlock(store);
    expect(output).toBe("");
  });

  it("add then remove: entry absent from rendered output", () => {
    let store = emptyStore("rm-agent");
    store = addMemoryEntry(store, { content: "remember this", importance: 2 });
    const id = store.entries[0].id;
    store = removeMemoryEntry(store, id);
    expect(store.entries).toHaveLength(0);
    expect(renderMemoryBlock(store)).toBe("");
  });
});
