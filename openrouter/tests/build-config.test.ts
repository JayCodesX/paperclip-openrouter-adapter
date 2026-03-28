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

  // ── wakeReasonModels ──────────────────────────────────────────────────────────

  it("wakeReasonModels set → config.wakeReasonModels matches", () => {
    const map = { comment: "deepseek/deepseek-r1", review: "openai/gpt-4o" };
    const config = buildOpenRouterConfig(
      makeValues({ wakeReasonModels: map } as Parameters<typeof makeValues>[0]),
    );
    expect(config.wakeReasonModels).toEqual(map);
  });

  it("wakeReasonModels empty object → key absent", () => {
    const config = buildOpenRouterConfig(
      makeValues({ wakeReasonModels: {} } as Parameters<typeof makeValues>[0]),
    );
    expect(Object.prototype.hasOwnProperty.call(config, "wakeReasonModels")).toBe(false);
  });

  // ── mcpServers ────────────────────────────────────────────────────────────────

  it("mcpServers set → config.mcpServers matches", () => {
    const servers = { myServer: { command: "npx", args: ["-y", "@my/mcp-server"] } };
    const config = buildOpenRouterConfig(
      makeValues({ mcpServers: servers } as Parameters<typeof makeValues>[0]),
    );
    expect(config.mcpServers).toEqual(servers);
  });

  it("requireMcpServers set → config.requireMcpServers matches", () => {
    const config = buildOpenRouterConfig(
      makeValues({ requireMcpServers: ["myServer"] } as Parameters<typeof makeValues>[0]),
    );
    expect(config.requireMcpServers).toEqual(["myServer"]);
  });

  // ── hookErrorMode ─────────────────────────────────────────────────────────────

  it("hookErrorMode 'fail' → config.hookErrorMode is 'fail'", () => {
    const config = buildOpenRouterConfig(
      makeValues({ hookErrorMode: "fail" } as Parameters<typeof makeValues>[0]),
    );
    expect(config.hookErrorMode).toBe("fail");
  });

  it("hookErrorMode 'ignore' → config.hookErrorMode is 'ignore'", () => {
    const config = buildOpenRouterConfig(
      makeValues({ hookErrorMode: "ignore" } as Parameters<typeof makeValues>[0]),
    );
    expect(config.hookErrorMode).toBe("ignore");
  });

  it("hookErrorMode unset → key absent", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(Object.prototype.hasOwnProperty.call(config, "hookErrorMode")).toBe(false);
  });

  // ── toolErrorBudgetHardStop ───────────────────────────────────────────────────

  it("toolErrorBudgetHardStop true → config.toolErrorBudgetHardStop is true", () => {
    const config = buildOpenRouterConfig(
      makeValues({ toolErrorBudgetHardStop: true } as Parameters<typeof makeValues>[0]),
    );
    expect(config.toolErrorBudgetHardStop).toBe(true);
  });

  it("toolErrorBudgetHardStop false → key absent (only set when true)", () => {
    const config = buildOpenRouterConfig(
      makeValues({ toolErrorBudgetHardStop: false } as Parameters<typeof makeValues>[0]),
    );
    expect(Object.prototype.hasOwnProperty.call(config, "toolErrorBudgetHardStop")).toBe(false);
  });

  // ── dryRun ────────────────────────────────────────────────────────────────────

  it("dryRun true → config.dryRun is true", () => {
    const config = buildOpenRouterConfig(
      makeValues({ dryRun: true } as Parameters<typeof makeValues>[0]),
    );
    expect(config.dryRun).toBe(true);
  });

  it("dryRun false → key absent (only set when true)", () => {
    const config = buildOpenRouterConfig(
      makeValues({ dryRun: false } as Parameters<typeof makeValues>[0]),
    );
    expect(Object.prototype.hasOwnProperty.call(config, "dryRun")).toBe(false);
  });

  // ── settingsFile ──────────────────────────────────────────────────────────────

  it("settingsFile set → config.settingsFile matches", () => {
    const config = buildOpenRouterConfig(
      makeValues({ settingsFile: "/home/user/.orager/custom-settings.json" } as Parameters<typeof makeValues>[0]),
    );
    expect(config.settingsFile).toBe("/home/user/.orager/custom-settings.json");
  });

  it("settingsFile empty string → key absent", () => {
    const config = buildOpenRouterConfig(
      makeValues({ settingsFile: "" } as Parameters<typeof makeValues>[0]),
    );
    expect(Object.prototype.hasOwnProperty.call(config, "settingsFile")).toBe(false);
  });
});

// ── New fields added in the S-series / C-series work ─────────────────────────

describe("buildOpenRouterConfig — profile field", () => {
  it("passes through profile when set", () => {
    const config = buildOpenRouterConfig(makeValues({ profile: "code-review" } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).profile).toBe("code-review");
  });

  it("omits profile when empty string", () => {
    const config = buildOpenRouterConfig(makeValues({ profile: "" } as Parameters<typeof makeValues>[0]));
    expect(Object.prototype.hasOwnProperty.call(config, "profile")).toBe(false);
  });
});

describe("buildOpenRouterConfig — webhookUrl field", () => {
  it("passes through webhookUrl when set", () => {
    const config = buildOpenRouterConfig(makeValues({ webhookUrl: "https://hooks.example.com/wh" } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).webhookUrl).toBe("https://hooks.example.com/wh");
  });

  it("omits webhookUrl when empty", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(Object.prototype.hasOwnProperty.call(config, "webhookUrl")).toBe(false);
  });
});

describe("buildOpenRouterConfig — summarizePrompt and summarizeFallbackKeep", () => {
  it("passes through summarizePrompt when set", () => {
    const config = buildOpenRouterConfig(makeValues({ summarizePrompt: "Summarize concisely." } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).summarizePrompt).toBe("Summarize concisely.");
  });

  it("passes through summarizeFallbackKeep = 0", () => {
    const config = buildOpenRouterConfig(makeValues({ summarizeFallbackKeep: 0 } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).summarizeFallbackKeep).toBe(0);
  });

  it("passes through summarizeFallbackKeep = 20", () => {
    const config = buildOpenRouterConfig(makeValues({ summarizeFallbackKeep: 20 } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).summarizeFallbackKeep).toBe(20);
  });
});

describe("buildOpenRouterConfig — hookTimeoutMs and approvalTimeoutMs", () => {
  it("passes through hookTimeoutMs when positive", () => {
    const config = buildOpenRouterConfig(makeValues({ hookTimeoutMs: 5000 } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).hookTimeoutMs).toBe(5000);
  });

  it("omits hookTimeoutMs when 0", () => {
    const config = buildOpenRouterConfig(makeValues({ hookTimeoutMs: 0 } as Parameters<typeof makeValues>[0]));
    expect(Object.prototype.hasOwnProperty.call(config, "hookTimeoutMs")).toBe(false);
  });

  it("passes through approvalTimeoutMs when positive", () => {
    const config = buildOpenRouterConfig(makeValues({ approvalTimeoutMs: 30000 } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).approvalTimeoutMs).toBe(30000);
  });
});

describe("buildOpenRouterConfig — preset and transforms", () => {
  it("passes through preset when set", () => {
    const config = buildOpenRouterConfig(makeValues({ preset: "my-preset" } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).preset).toBe("my-preset");
  });

  it("passes through transforms array when non-empty", () => {
    const config = buildOpenRouterConfig(makeValues({ transforms: ["nitro"] } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).transforms).toEqual(["nitro"]);
  });

  it("omits transforms when empty array", () => {
    const config = buildOpenRouterConfig(makeValues({ transforms: [] } as Parameters<typeof makeValues>[0]));
    expect(Object.prototype.hasOwnProperty.call(config, "transforms")).toBe(false);
  });
});

describe("buildOpenRouterConfig — otelEndpoint, otelServiceName, otelResourceAttributes", () => {
  it("passes through otelEndpoint when set", () => {
    const config = buildOpenRouterConfig(makeValues({ otelEndpoint: "http://otel.local:4318" } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).otelEndpoint).toBe("http://otel.local:4318");
  });

  it("passes through otelServiceName when set", () => {
    const config = buildOpenRouterConfig(makeValues({ otelServiceName: "my-agent" } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).otelServiceName).toBe("my-agent");
  });

  it("passes through otelResourceAttributes when set", () => {
    const config = buildOpenRouterConfig(makeValues({ otelResourceAttributes: "env=prod,team=agents" } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).otelResourceAttributes).toBe("env=prod,team=agents");
  });
});

describe("buildOpenRouterConfig — toolsFiles, maxRetries, addDirs", () => {
  it("passes through toolsFiles array when non-empty", () => {
    const config = buildOpenRouterConfig(makeValues({ toolsFiles: ["/tmp/tools.json"] } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).toolsFiles).toEqual(["/tmp/tools.json"]);
  });

  it("passes through maxRetries when >= 0", () => {
    const config = buildOpenRouterConfig(makeValues({ maxRetries: 2 } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).maxRetries).toBe(2);
  });

  it("passes through maxRetries = 0 (no retries)", () => {
    const config = buildOpenRouterConfig(makeValues({ maxRetries: 0 } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).maxRetries).toBe(0);
  });

  it("passes through addDirs array when non-empty", () => {
    const config = buildOpenRouterConfig(makeValues({ addDirs: ["/skills"] } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).addDirs).toEqual(["/skills"]);
  });
});

describe("buildOpenRouterConfig — maxTurns / timeoutSec / graceSec overrides", () => {
  it("overrides default maxTurns when caller provides positive value", () => {
    const config = buildOpenRouterConfig(makeValues({ maxTurns: 50 } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).maxTurns).toBe(50);
  });

  it("overrides default timeoutSec when caller provides value >= 0", () => {
    const config = buildOpenRouterConfig(makeValues({ timeoutSec: 300 } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).timeoutSec).toBe(300);
  });

  it("overrides default graceSec when caller provides value >= 0", () => {
    const config = buildOpenRouterConfig(makeValues({ graceSec: 60 } as Parameters<typeof makeValues>[0]));
    expect((config as Record<string, unknown>).graceSec).toBe(60);
  });
});

describe("buildOpenRouterConfig — memoryRetrieval", () => {
  it("includes memoryRetrieval and memoryEmbeddingModel when retrieval is 'embedding' and model provided", () => {
    const config = buildOpenRouterConfig(
      makeValues({
        memoryRetrieval: "embedding",
        memoryEmbeddingModel: "openai/text-embedding-3-small",
      } as Parameters<typeof makeValues>[0]),
    );
    expect((config as Record<string, unknown>).memoryRetrieval).toBe("embedding");
    expect((config as Record<string, unknown>).memoryEmbeddingModel).toBe("openai/text-embedding-3-small");
  });

  it("includes only memoryRetrieval when retrieval is 'embedding' but no model provided", () => {
    const config = buildOpenRouterConfig(
      makeValues({ memoryRetrieval: "embedding" } as Parameters<typeof makeValues>[0]),
    );
    expect((config as Record<string, unknown>).memoryRetrieval).toBe("embedding");
    expect(Object.prototype.hasOwnProperty.call(config, "memoryEmbeddingModel")).toBe(false);
  });

  it("does not include memoryRetrieval or memoryEmbeddingModel when retrieval is 'local'", () => {
    const config = buildOpenRouterConfig(
      makeValues({ memoryRetrieval: "local" } as Parameters<typeof makeValues>[0]),
    );
    expect(Object.prototype.hasOwnProperty.call(config, "memoryRetrieval")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(config, "memoryEmbeddingModel")).toBe(false);
  });

  it("does not include memoryRetrieval or memoryEmbeddingModel when memoryRetrieval is absent", () => {
    const config = buildOpenRouterConfig(makeValues());
    expect(Object.prototype.hasOwnProperty.call(config, "memoryRetrieval")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(config, "memoryEmbeddingModel")).toBe(false);
  });

  it("does not include memoryEmbeddingModel when provided without memoryRetrieval: 'embedding'", () => {
    const config = buildOpenRouterConfig(
      makeValues({
        memoryEmbeddingModel: "openai/text-embedding-3-small",
      } as Parameters<typeof makeValues>[0]),
    );
    expect(Object.prototype.hasOwnProperty.call(config, "memoryRetrieval")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(config, "memoryEmbeddingModel")).toBe(false);
  });
});
