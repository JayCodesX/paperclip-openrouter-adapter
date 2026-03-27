/**
 * Unit tests for skills.ts — listOpenRouterSkills and syncOpenRouterSkills.
 *
 * The openrouter adapter uses the add-dir mode for skills (loaded from
 * filesystem directories, not registered via API), so both functions return
 * a static snapshot with a warning. These tests verify that contract.
 */
import { describe, it, expect } from "vitest";
import {
  listOpenRouterSkills,
  syncOpenRouterSkills,
} from "../src/server/skills.js";

describe("listOpenRouterSkills", () => {
  it("returns adapterType openrouter", async () => {
    const result = await listOpenRouterSkills(null);
    expect(result.adapterType).toBe("openrouter");
  });

  it("reports supported: true (add-dir mode is supported)", async () => {
    const result = await listOpenRouterSkills(null);
    expect(result.supported).toBe(true);
  });

  it("reports mode add-dir", async () => {
    const result = await listOpenRouterSkills(null);
    expect(result.mode).toBe("add-dir");
  });

  it("includes a warning about the add-dir mechanism", async () => {
    const result = await listOpenRouterSkills(null);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("addDirs"))).toBe(true);
  });

  it("returns empty desiredSkills and entries", async () => {
    const result = await listOpenRouterSkills(null);
    expect(result.desiredSkills).toEqual([]);
    expect(result.entries).toEqual([]);
  });
});

describe("syncOpenRouterSkills", () => {
  it("returns the same adapterType and mode as list", async () => {
    const result = await syncOpenRouterSkills(null, ["some-skill"]);
    expect(result.adapterType).toBe("openrouter");
    expect(result.mode).toBe("add-dir");
  });

  it("includes the 'does not write' warning", async () => {
    const result = await syncOpenRouterSkills(null, ["skill-a"]);
    expect(result.warnings.some((w) => w.includes("does not write"))).toBe(true);
  });

  it("echoes back valid desiredSkills strings", async () => {
    const result = await syncOpenRouterSkills(null, ["skill-a", "skill-b"]);
    expect(result.desiredSkills).toEqual(["skill-a", "skill-b"]);
  });

  it("filters out empty or non-string entries from desiredSkills", async () => {
    const result = await syncOpenRouterSkills(null, ["valid", "", "  ", "also-valid"]);
    expect(result.desiredSkills).not.toContain("");
    expect(result.desiredSkills).not.toContain("  ");
    expect(result.desiredSkills.some((s) => s.trim().length > 0)).toBe(true);
  });

  it("adds a warning for invalid (empty/non-string) entries", async () => {
    const result = await syncOpenRouterSkills(null, ["valid", "", "  "]);
    expect(result.warnings.some((w) => w.includes("could not be resolved"))).toBe(true);
  });

  it("does not add the invalid-entry warning when all skills are valid", async () => {
    const result = await syncOpenRouterSkills(null, ["skill-x"]);
    expect(result.warnings.some((w) => w.includes("could not be resolved"))).toBe(false);
  });

  it("handles empty desiredSkills array without error", async () => {
    const result = await syncOpenRouterSkills(null, []);
    expect(result.desiredSkills).toEqual([]);
  });
});
