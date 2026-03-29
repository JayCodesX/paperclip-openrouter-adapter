import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  listOpenRouterModels,
  _resetModelCacheForTesting,
} from "../src/server/list-models.js";
import { models as fallbackModels } from "../src/index.js";

beforeEach(() => {
  _resetModelCacheForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(response: { ok: boolean; data?: unknown } | null) {
  if (response === null) {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    return;
  }
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: response.ok,
      json: async () => response.data ?? {},
    }),
  );
}

// ── fetchModels / listOpenRouterModels ────────────────────────────────────────

describe("listOpenRouterModels", () => {
  it("returns supportsVision: true when input_modalities contains 'image'", async () => {
    mockFetch({
      ok: true,
      data: {
        data: [
          { id: "openai/gpt-4o", name: "GPT-4o", input_modalities: ["text", "image"] },
        ],
      },
    });
    const models = await listOpenRouterModels();
    const m = models.find((m) => m.id === "openai/gpt-4o");
    expect(m).toBeDefined();
    expect(m?.supportsVision).toBe(true);
  });

  it("returns supportsVision: true when image is only in architecture.input_modalities", async () => {
    mockFetch({
      ok: true,
      data: {
        data: [
          {
            id: "meta-llama/llama-3.2-11b-vision-instruct",
            name: "Llama 3.2 11B Vision",
            architecture: { input_modalities: ["text", "image"] },
          },
        ],
      },
    });
    const models = await listOpenRouterModels();
    const m = models.find((m) => m.id === "meta-llama/llama-3.2-11b-vision-instruct");
    expect(m?.supportsVision).toBe(true);
  });

  it("returns supportsVision: false when modalities contain only 'text'", async () => {
    mockFetch({
      ok: true,
      data: {
        data: [
          { id: "deepseek/deepseek-r1", name: "DeepSeek R1", input_modalities: ["text"] },
        ],
      },
    });
    const models = await listOpenRouterModels();
    const m = models.find((m) => m.id === "deepseek/deepseek-r1");
    expect(m?.supportsVision).toBe(false);
  });

  it("returns supportsVision: false when input_modalities is absent", async () => {
    mockFetch({
      ok: true,
      data: {
        data: [{ id: "some/text-model", name: "Text Only" }],
      },
    });
    const models = await listOpenRouterModels();
    const m = models.find((m) => m.id === "some/text-model");
    expect(m?.supportsVision).toBe(false);
  });

  it("uses name field as label when present", async () => {
    mockFetch({
      ok: true,
      data: { data: [{ id: "openai/gpt-4o", name: "GPT-4o", input_modalities: ["text", "image"] }] },
    });
    const models = await listOpenRouterModels();
    expect(models[0].label).toBe("GPT-4o");
  });

  it("falls back to id as label when name is absent", async () => {
    mockFetch({
      ok: true,
      data: { data: [{ id: "openai/gpt-4o", input_modalities: ["text"] }] },
    });
    const models = await listOpenRouterModels();
    expect(models[0].label).toBe("openai/gpt-4o");
  });

  it("falls back to id as label when name is empty string", async () => {
    mockFetch({
      ok: true,
      data: { data: [{ id: "openai/gpt-4o", name: "", input_modalities: ["text"] }] },
    });
    const models = await listOpenRouterModels();
    expect(models[0].label).toBe("openai/gpt-4o");
  });

  it("skips entries with missing id", async () => {
    mockFetch({
      ok: true,
      data: {
        data: [
          { name: "No ID model", input_modalities: ["text"] },
          { id: "valid/model", name: "Valid", input_modalities: ["text"] },
        ],
      },
    });
    const models = await listOpenRouterModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("valid/model");
  });

  it("skips entries with empty id", async () => {
    mockFetch({
      ok: true,
      data: {
        data: [
          { id: "  ", name: "Blank ID", input_modalities: ["text"] },
          { id: "valid/model", name: "Valid", input_modalities: ["text"] },
        ],
      },
    });
    const models = await listOpenRouterModels();
    expect(models.find((m) => m.id.trim() === "")).toBeUndefined();
    expect(models).toHaveLength(1);
  });

  it("returns hardcoded fallback list when fetch returns non-ok status", async () => {
    mockFetch({ ok: false });
    const models = await listOpenRouterModels();
    expect(models).toEqual(fallbackModels);
  });

  it("returns hardcoded fallback list when fetch throws", async () => {
    mockFetch(null);
    const models = await listOpenRouterModels();
    expect(models).toEqual(fallbackModels);
  });

  it("returns stale cache rather than hardcoded fallback when fetch fails but cache is populated", async () => {
    // First fetch populates cache
    mockFetch({
      ok: true,
      data: { data: [{ id: "cached/model", name: "Cached", input_modalities: ["text", "image"] }] },
    });
    await listOpenRouterModels();

    // Subsequent fetch fails — should return stale cache
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const models = await listOpenRouterModels();
    expect(models[0].id).toBe("cached/model");
  });

  it("caches result — second call within TTL does not call fetch again", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "openai/gpt-4o", name: "GPT-4o", input_modalities: ["text", "image"] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await listOpenRouterModels();
    await listOpenRouterModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cache expires after 5 minutes — re-fetches after TTL elapses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "openai/gpt-4o", name: "GPT-4o", input_modalities: ["text", "image"] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    await listOpenRouterModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance just under 5 minutes — should still be cached
    vi.advanceTimersByTime(4 * 60 * 1000 + 59_000);
    await listOpenRouterModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past 5 minutes — cache should be expired
    vi.advanceTimersByTime(2000);
    await listOpenRouterModels();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("_resetModelCacheForTesting clears cache — next call re-fetches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "openai/gpt-4o", name: "GPT-4o", input_modalities: ["text", "image"] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await listOpenRouterModels();
    _resetModelCacheForTesting();
    await listOpenRouterModels();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── Hardcoded fallback list vision annotations ────────────────────────────────

describe("hardcoded fallback models (src/index.ts)", () => {
  it("deepseek/deepseek-chat-v3-2 has supportsVision: false", () => {
    const m = fallbackModels.find((m) => m.id === "deepseek/deepseek-chat-v3-2");
    expect(m?.supportsVision).toBe(false);
  });

  it("deepseek/deepseek-r1 has supportsVision: false", () => {
    const m = fallbackModels.find((m) => m.id === "deepseek/deepseek-r1");
    expect(m?.supportsVision).toBe(false);
  });

  it("anthropic/claude-sonnet-4-6 has supportsVision: true", () => {
    const m = fallbackModels.find((m) => m.id === "anthropic/claude-sonnet-4-6");
    expect(m?.supportsVision).toBe(true);
  });

  it("openai/gpt-4o has supportsVision: true", () => {
    const m = fallbackModels.find((m) => m.id === "openai/gpt-4o");
    expect(m?.supportsVision).toBe(true);
  });

  it("google/gemini-2.5-pro has supportsVision: true", () => {
    const m = fallbackModels.find((m) => m.id === "google/gemini-2.5-pro");
    expect(m?.supportsVision).toBe(true);
  });

  it("meta-llama/llama-3.3-70b-instruct has supportsVision: false", () => {
    const m = fallbackModels.find((m) => m.id === "meta-llama/llama-3.3-70b-instruct");
    expect(m?.supportsVision).toBe(false);
  });

  it("every model in the fallback list has a supportsVision boolean", () => {
    for (const m of fallbackModels) {
      expect(typeof m.supportsVision, `${m.id} missing supportsVision`).toBe("boolean");
    }
  });
});
