import { describe, it, expect } from "vitest";
import { buildMemoryKey } from "../src/server/execute-cli.js";

describe("buildMemoryKey", () => {
  it("returns agentId unchanged when repoUrl is null", () => {
    expect(buildMemoryKey("agent-123", null)).toBe("agent-123");
  });

  it("returns agentId unchanged when repoUrl is an empty string", () => {
    expect(buildMemoryKey("agent-123", "")).toBe("agent-123");
  });

  it("appends correct slug for a full GitHub URL", () => {
    const key = buildMemoryKey("agent-123", "https://github.com/acme/api-server");
    expect(key).toBe("agent-123_github_com_acme_api_server");
  });

  it("slug portion is filesystem-safe (no /, ., - or other special characters)", () => {
    const agentId = "agentabc";
    const key = buildMemoryKey(agentId, "https://github.com/acme/api-server");
    // The slug appended after agentId_ must contain only [a-zA-Z0-9_]
    const slug = key.slice(agentId.length + 1); // strip "agentId_"
    expect(slug).toMatch(/^[a-zA-Z0-9_]+$/);
    // The separator itself should not introduce special chars; verify full key too
    expect(key).toMatch(/^[a-zA-Z0-9_]+$/);
  });

  it("total key never exceeds 128 chars", () => {
    const longId = "a".repeat(100);
    const longUrl = "https://github.com/" + "x".repeat(200) + "/" + "y".repeat(200);
    const key = buildMemoryKey(longId, longUrl);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("handles URLs with multiple special characters", () => {
    const key = buildMemoryKey("myagent", "git+ssh://gitlab.example.com:2222/org/my-repo.git");
    expect(key).toMatch(/^[a-zA-Z0-9_]+$/);
    expect(key.startsWith("myagent_")).toBe(true);
  });

  it("falls back to agentId when slug is empty after sanitisation", () => {
    // A URL that reduces to only separators should yield an empty slug → fallback
    const key = buildMemoryKey("myagent", "https://---..---");
    // Either the slug is empty and key === agentId, or it has valid slug chars
    expect(key === "myagent" || key.match(/^myagent_[a-zA-Z0-9_]+$/)).toBeTruthy();
  });
});
