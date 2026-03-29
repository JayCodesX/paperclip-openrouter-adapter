/**
 * Tests for skills.ts — ephemeral symlink-based skills injection.
 *
 * buildOragerSkillsDir() creates a temp directory populated with symlinks to
 * the available Paperclip skills, ready to be passed to orager as an addDirs
 * entry. cleanupOragerSkillsDir() removes it after the run.
 *
 * listOpenRouterSkills / syncOpenRouterSkills reflect the available skill names
 * and warn about desired skills that are missing.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildOragerSkillsDir,
  cleanupOragerSkillsDir,
  listOpenRouterSkills,
  syncOpenRouterSkills,
} from "../src/server/skills.js";

// ESM modules are not configurable via vi.spyOn — use vi.mock at the top level.
vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  listPaperclipSkillEntries: vi.fn(),
  ensurePaperclipSkillSymlink: vi.fn(),
}));

import { listPaperclipSkillEntries, ensurePaperclipSkillSymlink } from "@paperclipai/adapter-utils/server-utils";

const mockListEntries = vi.mocked(listPaperclipSkillEntries);
const mockEnsureSymlink = vi.mocked(ensurePaperclipSkillSymlink);

// ── helpers ───────────────────────────────────────────────────────────────────

async function makeFakeSkillsDir(names: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "test-skills-root-"));
  for (const name of names) {
    await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.writeFile(path.join(root, name, "SKILL.md"), `# ${name}\nFake skill.`);
  }
  return root;
}

// ── buildOragerSkillsDir ──────────────────────────────────────────────────────

describe("buildOragerSkillsDir", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when no Paperclip skills directory is found", async () => {
    mockListEntries.mockResolvedValue([]);
    const result = await buildOragerSkillsDir([]);
    expect(result).toBeNull();
  });

  it("creates a temp dir with symlinks for all available skills when desiredSkills is empty", async () => {
    const fakeRoot = await makeFakeSkillsDir(["get-task", "post-comment"]);
    mockListEntries.mockResolvedValue([
      { name: "get-task",     source: path.join(fakeRoot, "get-task") },
      { name: "post-comment", source: path.join(fakeRoot, "post-comment") },
    ]);
    // ensurePaperclipSkillSymlink is mocked — simulate it creating the symlinks
    mockEnsureSymlink.mockImplementation(async (source: string, target: string) => {
      await fs.symlink(source, target);
    });

    const result = await buildOragerSkillsDir([]);
    expect(result).not.toBeNull();
    expect(result!.linked).toEqual(expect.arrayContaining(["get-task", "post-comment"]));
    expect(result!.missing).toHaveLength(0);

    // Verify symlinks exist in the temp dir
    const gtStat = await fs.lstat(path.join(result!.dir, "get-task"));
    expect(gtStat.isSymbolicLink()).toBe(true);

    await cleanupOragerSkillsDir(result!.dir);
    await fs.rm(fakeRoot, { recursive: true, force: true });
  });

  it("only symlinks desired skills when desiredSkills is specified", async () => {
    const fakeRoot = await makeFakeSkillsDir(["get-task", "post-comment", "list-issues"]);
    mockListEntries.mockResolvedValue([
      { name: "get-task",     source: path.join(fakeRoot, "get-task") },
      { name: "post-comment", source: path.join(fakeRoot, "post-comment") },
      { name: "list-issues",  source: path.join(fakeRoot, "list-issues") },
    ]);
    mockEnsureSymlink.mockImplementation(async (source: string, target: string) => {
      await fs.symlink(source, target);
    });

    const result = await buildOragerSkillsDir(["get-task"]);
    expect(result).not.toBeNull();
    expect(result!.linked).toEqual(["get-task"]);
    expect(result!.missing).toHaveLength(0);

    // Only get-task should be symlinked
    const entries = await fs.readdir(result!.dir);
    expect(entries).toEqual(["get-task"]);

    await cleanupOragerSkillsDir(result!.dir);
    await fs.rm(fakeRoot, { recursive: true, force: true });
  });

  it("reports missing when a desired skill is not in available entries", async () => {
    const fakeRoot = await makeFakeSkillsDir(["get-task"]);
    mockListEntries.mockResolvedValue([
      { name: "get-task", source: path.join(fakeRoot, "get-task") },
    ]);
    mockEnsureSymlink.mockImplementation(async (source: string, target: string) => {
      await fs.symlink(source, target);
    });

    const result = await buildOragerSkillsDir(["get-task", "nonexistent-skill"]);
    expect(result).not.toBeNull();
    expect(result!.linked).toContain("get-task");
    expect(result!.missing).toContain("nonexistent-skill");

    await cleanupOragerSkillsDir(result!.dir);
    await fs.rm(fakeRoot, { recursive: true, force: true });
  });

  it("symlink target resolves to the source directory", async () => {
    const fakeRoot = await makeFakeSkillsDir(["get-task"]);
    mockListEntries.mockResolvedValue([
      { name: "get-task", source: path.join(fakeRoot, "get-task") },
    ]);
    mockEnsureSymlink.mockImplementation(async (source: string, target: string) => {
      await fs.symlink(source, target);
    });

    const result = await buildOragerSkillsDir([]);
    expect(result).not.toBeNull();
    const linkTarget = await fs.readlink(path.join(result!.dir, "get-task"));
    expect(linkTarget).toBe(path.join(fakeRoot, "get-task"));

    await cleanupOragerSkillsDir(result!.dir);
    await fs.rm(fakeRoot, { recursive: true, force: true });
  });

  it("is case-insensitive when matching desired skill names", async () => {
    const fakeRoot = await makeFakeSkillsDir(["Get-Task"]);
    mockListEntries.mockResolvedValue([
      { name: "Get-Task", source: path.join(fakeRoot, "Get-Task") },
    ]);
    mockEnsureSymlink.mockImplementation(async (source: string, target: string) => {
      await fs.symlink(source, target);
    });

    const result = await buildOragerSkillsDir(["get-task"]);
    expect(result).not.toBeNull();
    expect(result!.linked).toContain("Get-Task");

    await cleanupOragerSkillsDir(result!.dir);
    await fs.rm(fakeRoot, { recursive: true, force: true });
  });
});

// ── cleanupOragerSkillsDir ────────────────────────────────────────────────────

describe("cleanupOragerSkillsDir", () => {
  it("removes the temp directory after a run", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "test-cleanup-"));
    await fs.writeFile(path.join(tmp, "dummy.txt"), "data");

    await cleanupOragerSkillsDir(tmp);

    await expect(fs.stat(tmp)).rejects.toThrow();
  });

  it("does not throw when the directory does not exist", async () => {
    await expect(cleanupOragerSkillsDir("/nonexistent/path/xyz")).resolves.toBeUndefined();
  });
});

// ── listOpenRouterSkills / syncOpenRouterSkills ───────────────────────────────

describe("listOpenRouterSkills", () => {
  afterEach(() => vi.resetAllMocks());

  it("returns adapterType openrouter, supported true, mode ephemeral", async () => {
    mockListEntries.mockResolvedValue([
      { name: "get-task", source: "/fake/get-task" },
    ]);
    const result = await listOpenRouterSkills(null);
    expect(result.adapterType).toBe("openrouter");
    expect(result.supported).toBe(true);
    expect(result.mode).toBe("ephemeral");
  });

  it("returns available skill names in entries", async () => {
    mockListEntries.mockResolvedValue([
      { name: "get-task",     source: "/fake/get-task" },
      { name: "post-comment", source: "/fake/post-comment" },
    ]);
    const result = await listOpenRouterSkills(null);
    expect(result.entries).toEqual(expect.arrayContaining(["get-task", "post-comment"]));
  });

  it("returns empty entries when no skills directory found", async () => {
    mockListEntries.mockResolvedValue([]);
    const result = await listOpenRouterSkills(null);
    expect(result.entries).toEqual([]);
  });
});

describe("syncOpenRouterSkills", () => {
  afterEach(() => vi.resetAllMocks());

  it("echoes back valid desiredSkills", async () => {
    mockListEntries.mockResolvedValue([
      { name: "get-task", source: "/fake/get-task" },
    ]);
    const result = await syncOpenRouterSkills(null, ["get-task"]);
    expect(result.desiredSkills).toContain("get-task");
  });

  it("filters out empty or whitespace-only entries from desiredSkills", async () => {
    mockListEntries.mockResolvedValue([]);
    const result = await syncOpenRouterSkills(null, ["valid", "", "  "]);
    expect(result.desiredSkills).toEqual(["valid"]);
  });

  it("warns about desired skills not available in the skills directory", async () => {
    mockListEntries.mockResolvedValue([
      { name: "get-task", source: "/fake/get-task" },
    ]);
    const result = await syncOpenRouterSkills(null, ["get-task", "unknown-skill"]);
    expect(result.warnings.some((w) => w.includes("unknown-skill"))).toBe(true);
  });

  it("does not warn when all desired skills are available", async () => {
    mockListEntries.mockResolvedValue([
      { name: "get-task", source: "/fake/get-task" },
    ]);
    const result = await syncOpenRouterSkills(null, ["get-task"]);
    expect(result.warnings).toHaveLength(0);
  });

  it("handles empty desiredSkills without error", async () => {
    mockListEntries.mockResolvedValue([]);
    const result = await syncOpenRouterSkills(null, []);
    expect(result.desiredSkills).toEqual([]);
    expect(result.warnings).toHaveLength(0);
  });
});
