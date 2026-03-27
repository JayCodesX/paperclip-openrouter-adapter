import { describe, it, expect } from "vitest";
import { buildOpenRouterConfig } from "../src/ui/build-config.js";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

// Minimal valid CreateConfigValues for testing
function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "openrouter",
    cwd: "/tmp",
    promptTemplate: "",
    model: "",
    thinkingEffort: "medium",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    dangerouslyBypassSandbox: false,
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    ...overrides,
  } as CreateConfigValues;
}

describe("buildOpenRouterConfig", () => {
  it("returns object with correct default values", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(config).toMatchObject({
      timeoutSec: 0,
      graceSec: 20,
      maxTurns: 20,
    });
  });

  it("timeoutSec is 0 (unlimited)", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(config.timeoutSec).toBe(0);
  });

  it("graceSec is 20", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(config.graceSec).toBe(20);
  });

  it("maxTurns is 20", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(config.maxTurns).toBe(20);
  });

  it("passes through model when provided", () => {
    const config = buildOpenRouterConfig(makeValues({ model: "gpt-4o" }));
    expect(config.model).toBe("gpt-4o");
  });

  it("does not include model key when model is empty string", () => {
    const config = buildOpenRouterConfig(makeValues({ model: "" }));
    expect(Object.prototype.hasOwnProperty.call(config, "model")).toBe(false);
  });

  it("passes through promptTemplate when provided", () => {
    const config = buildOpenRouterConfig(makeValues({ promptTemplate: "You are a helpful assistant." }));
    expect(config.promptTemplate).toBe("You are a helpful assistant.");
  });

  it("does not include promptTemplate key when promptTemplate is empty string", () => {
    const config = buildOpenRouterConfig(makeValues({ promptTemplate: "" }));
    expect(Object.prototype.hasOwnProperty.call(config, "promptTemplate")).toBe(false);
  });

  it("passes through bootstrapPrompt as bootstrapPromptTemplate", () => {
    const config = buildOpenRouterConfig(makeValues({ bootstrapPrompt: "Start with a greeting." }));
    expect(config.bootstrapPromptTemplate).toBe("Start with a greeting.");
  });

  it("does not include bootstrapPromptTemplate key when bootstrapPrompt is empty string", () => {
    const config = buildOpenRouterConfig(makeValues({ bootstrapPrompt: "" }));
    expect(Object.prototype.hasOwnProperty.call(config, "bootstrapPromptTemplate")).toBe(false);
  });

  it("includes all three defaults alongside model and templates", () => {
    const config = buildOpenRouterConfig(
      makeValues({
        model: "claude-3-opus",
        promptTemplate: "Be concise.",
        bootstrapPrompt: "Hello!",
      }),
    );
    expect(config).toMatchObject({
      model: "claude-3-opus",
      promptTemplate: "Be concise.",
      bootstrapPromptTemplate: "Hello!",
      timeoutSec: 0,
      graceSec: 20,
      maxTurns: 20,
    });
  });

  it("returns a plain object", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(typeof config).toBe("object");
    expect(config).not.toBeNull();
    expect(Array.isArray(config)).toBe(false);
  });

  // ── fallbackModel ────────────────────────────────────────────────────────────

  it("fallbackModel set → config.models is [fallbackModel]", () => {
    const config = buildOpenRouterConfig(
      makeValues({ fallbackModel: "openai/gpt-4o" } as Parameters<typeof makeValues>[0]),
    );
    expect(config.models).toEqual(["openai/gpt-4o"]);
  });

  it("fallbackModel empty string → config.models key absent", () => {
    const config = buildOpenRouterConfig(
      makeValues({ fallbackModel: "" } as Parameters<typeof makeValues>[0]),
    );
    expect(Object.prototype.hasOwnProperty.call(config, "models")).toBe(false);
  });

  it("fallbackModel unset → config.models key absent", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(Object.prototype.hasOwnProperty.call(config, "models")).toBe(false);
  });

  // ── visionModel ──────────────────────────────────────────────────────────────

  it("visionModel set → config.visionFallbackModels is [visionModel]", () => {
    const config = buildOpenRouterConfig(
      makeValues({ visionModel: "openai/gpt-4o" } as Parameters<typeof makeValues>[0]),
    );
    expect(config.visionFallbackModels).toEqual(["openai/gpt-4o"]);
  });

  it("visionModel empty string → config.visionFallbackModels key absent", () => {
    const config = buildOpenRouterConfig(
      makeValues({ visionModel: "" } as Parameters<typeof makeValues>[0]),
    );
    expect(Object.prototype.hasOwnProperty.call(config, "visionFallbackModels")).toBe(false);
  });

  it("visionModel unset → config.visionFallbackModels key absent", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(Object.prototype.hasOwnProperty.call(config, "visionFallbackModels")).toBe(false);
  });

  // ── both set ─────────────────────────────────────────────────────────────────

  it("both fallbackModel and visionModel set → both keys present", () => {
    const config = buildOpenRouterConfig(
      makeValues({
        fallbackModel: "anthropic/claude-sonnet-4-6",
        visionModel: "openai/gpt-4o",
      } as Parameters<typeof makeValues>[0]),
    );
    expect(config.models).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(config.visionFallbackModels).toEqual(["openai/gpt-4o"]);
  });

  it("neither fallbackModel nor visionModel set → neither key present", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(Object.prototype.hasOwnProperty.call(config, "models")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(config, "visionFallbackModels")).toBe(false);
  });
});
