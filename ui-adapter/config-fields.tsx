import { useState } from "react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  DraftTextarea,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const selectClass = inputClass;

const sectionHeadingClass =
  "text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50 pt-3 pb-1";

const WAKE_REASONS = [
  "manual",
  "comment_added",
  "pr_opened",
  "pr_updated",
  "scheduled",
  "webhook",
] as const;

const PROVIDER_SLUGS = [
  "Anthropic",
  "Azure",
  "AWS Bedrock",
  "Cloudflare",
  "Cohere",
  "DeepInfra",
  "DeepSeek",
  "Fireworks",
  "Google",
  "Google AI Studio",
  "Groq",
  "HuggingFace",
  "Lambda",
  "Lepton",
  "Mancer",
  "Meta",
  "Microsoft",
  "Mistral",
  "Novita",
  "OpenAI",
  "Perplexity",
  "Recursal",
  "Replicate",
  "SambaNova",
  "Together",
  "xAI",
] as const;

const EMBEDDING_MODELS = [
  { id: "openai/text-embedding-3-small", label: "OpenAI: text-embedding-3-small" },
  { id: "openai/text-embedding-3-large", label: "OpenAI: text-embedding-3-large" },
  { id: "openai/text-embedding-ada-002", label: "OpenAI: text-embedding-ada-002" },
  { id: "google/text-embedding-004", label: "Google: text-embedding-004" },
  { id: "cohere/embed-english-v3.0", label: "Cohere: embed-english-v3.0" },
  { id: "cohere/embed-multilingual-v3.0", label: "Cohere: embed-multilingual-v3.0" },
] as const;

interface TurnModelRule {
  model: string;
  afterTurn?: number;
  costAbove?: number;
  tokensAbove?: number;
  once?: boolean;
}

interface ReasoningConfig {
  effort?: "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
  max_tokens?: number;
  exclude?: boolean;
}

interface ProviderConfig {
  order?: string[];
  only?: string[];
  ignore?: string[];
  data_collection?: "deny";
  zdr?: boolean;
  sort?: "latency" | "price" | "throughput";
}

export function OpenRouterConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  // Draft state for new wakeReasonModels row
  const [newWakeReason, setNewWakeReason] = useState("");
  const [newWakeModel, setNewWakeModel] = useState("");

  // Draft state for new turnModelRules row
  const [newRuleModel, setNewRuleModel] = useState("");
  const [newRuleAfterTurn, setNewRuleAfterTurn] = useState<number | "">("");
  const [newRuleCostAbove, setNewRuleCostAbove] = useState<number | "">("");
  const [newRuleTokensAbove, setNewRuleTokensAbove] = useState<number | "">(
    "",
  );
  const [newRuleOnce, setNewRuleOnce] = useState(false);

  // ---- Helpers for reading current composite values ----

  const getWakeReasonModels = (): Record<string, string> => {
    if (isCreate)
      return (values!.wakeReasonModels as Record<string, string>) ?? {};
    return (config.wakeReasonModels as Record<string, string>) ?? {};
  };

  const getTurnModelRules = (): TurnModelRule[] => {
    if (isCreate) return (values!.turnModelRules as TurnModelRule[]) ?? [];
    return (config.turnModelRules as TurnModelRule[]) ?? [];
  };

  const getReasoning = (): ReasoningConfig => {
    if (isCreate) return (values!.reasoning as ReasoningConfig) ?? {};
    return (config.reasoning as ReasoningConfig) ?? {};
  };

  const getProvider = (): ProviderConfig => {
    if (isCreate) return (values!.provider as ProviderConfig) ?? {};
    return (config.provider as ProviderConfig) ?? {};
  };

  // ---- Helpers for committing composite values ----

  const commitWakeReasonModels = (v: Record<string, string>) => {
    if (isCreate) set!({ wakeReasonModels: v });
    else mark("adapterConfig", "wakeReasonModels", v);
  };

  const commitTurnModelRules = (v: TurnModelRule[]) => {
    if (isCreate) set!({ turnModelRules: v });
    else mark("adapterConfig", "turnModelRules", v);
  };

  const commitReasoning = (patch: Partial<ReasoningConfig>) => {
    const next = { ...getReasoning(), ...patch };
    if (isCreate) set!({ reasoning: next });
    else mark("adapterConfig", "reasoning", next);
  };

  const commitProvider = (patch: Partial<ProviderConfig>) => {
    const next = { ...getProvider(), ...patch };
    if (isCreate) set!({ provider: next });
    else mark("adapterConfig", "provider", next);
  };

  // ---- Derived values for render ----

  const wakeReasonModels = getWakeReasonModels();
  const turnModelRules = getTurnModelRules();
  const reasoning = getReasoning();
  const provider = getProvider();

  const unusedWakeReasons = WAKE_REASONS.filter((r) => !(r in wakeReasonModels));

  // ---- Wake reason model add/remove ----

  const addWakeReason = () => {
    if (!newWakeReason || !newWakeModel) return;
    commitWakeReasonModels({ ...wakeReasonModels, [newWakeReason]: newWakeModel });
    setNewWakeReason("");
    setNewWakeModel("");
  };

  const removeWakeReason = (key: string) => {
    const next = { ...wakeReasonModels };
    delete next[key];
    commitWakeReasonModels(next);
  };

  // ---- Turn model rule add/remove ----

  const addTurnRule = () => {
    if (!newRuleModel) return;
    const rule: TurnModelRule = { model: newRuleModel };
    if (newRuleAfterTurn !== "") rule.afterTurn = Number(newRuleAfterTurn);
    if (newRuleCostAbove !== "") rule.costAbove = Number(newRuleCostAbove);
    if (newRuleTokensAbove !== "")
      rule.tokensAbove = Number(newRuleTokensAbove);
    if (newRuleOnce) rule.once = true;
    commitTurnModelRules([...turnModelRules, rule]);
    setNewRuleModel("");
    setNewRuleAfterTurn("");
    setNewRuleCostAbove("");
    setNewRuleTokensAbove("");
    setNewRuleOnce(false);
  };

  const removeTurnRule = (idx: number) => {
    commitTurnModelRules(turnModelRules.filter((_, i) => i !== idx));
  };

  const visionModels = models.filter((m) => m.supportsVision);

  // Determine if the currently selected model supports reasoning (extended thinking).
  // Falls back to false when models haven't loaded yet or the model is unknown.
  const selectedModelId = isCreate
    ? (values!.model ?? "")
    : eff("adapterConfig", "model", String(config.model ?? ""));
  const selectedModel = models.find((m) => m.id === selectedModelId);
  // supportsReasoning may not be in the shared types but is present at runtime
  const selectedModelSupportsReasoning =
    (selectedModel as { supportsReasoning?: boolean } | undefined)?.supportsReasoning ?? false;

  return (
    <>
      {/* ===== CORE ===== */}
      <Field
        label="API Key"
        hint="OpenRouter API key. In production use a secret_ref instead of a plaintext value."
      >
        <DraftInput
          value={
            isCreate
              ? values!.apiKey ?? ""
              : eff("adapterConfig", "apiKey", String(config.apiKey ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ apiKey: v })
              : mark("adapterConfig", "apiKey", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="sk-or-..."
        />
      </Field>

      <Field label="Model" hint={help.model}>
        {models.length > 0 ? (
          <select
            className={selectClass}
            value={
              isCreate
                ? values!.model ?? ""
                : eff("adapterConfig", "model", String(config.model ?? ""))
            }
            onChange={(e) =>
              isCreate
                ? set!({ model: e.target.value })
                : mark("adapterConfig", "model", e.target.value || undefined)
            }
          >
            <option value="">Default (deepseek/deepseek-chat-v3-0324)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <DraftInput
            value={
              isCreate
                ? values!.model ?? ""
                : eff("adapterConfig", "model", String(config.model ?? ""))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ model: v })
                : mark("adapterConfig", "model", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="deepseek/deepseek-chat-v3-0324"
          />
        )}
      </Field>

      <Field
        label="Fallback Model"
        hint="Used when the primary model fails (e.g. rate limit)."
      >
        {models.length > 0 ? (
          <select
            aria-label="Fallback Model"
            className={selectClass}
            value={
              isCreate
                ? (values!.fallbackModel as string) ?? ""
                : eff("adapterConfig", "fallbackModel", String(config.fallbackModel ?? ""))
            }
            onChange={(e) =>
              isCreate
                ? set!({ fallbackModel: e.target.value || undefined })
                : mark("adapterConfig", "fallbackModel", e.target.value || undefined)
            }
          >
            <option value="">None (use primary only)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <DraftInput
            value={
              isCreate
                ? (values!.fallbackModel as string) ?? ""
                : eff("adapterConfig", "fallbackModel", String(config.fallbackModel ?? ""))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ fallbackModel: v || undefined })
                : mark("adapterConfig", "fallbackModel", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="model-id (optional)"
          />
        )}
      </Field>

      <Field
        label="Vision Model"
        hint="Overrides the primary model when the task contains images."
      >
        {visionModels.length > 0 ? (
          <select
            aria-label="Vision Model"
            className={selectClass}
            value={
              isCreate
                ? (values!.visionModel as string) ?? ""
                : eff("adapterConfig", "visionModel", String(config.visionModel ?? ""))
            }
            onChange={(e) =>
              isCreate
                ? set!({ visionModel: e.target.value || undefined })
                : mark("adapterConfig", "visionModel", e.target.value || undefined)
            }
          >
            <option value="">None (auto-select)</option>
            {visionModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <DraftInput
            value={
              isCreate
                ? (values!.visionModel as string) ?? ""
                : eff("adapterConfig", "visionModel", String(config.visionModel ?? ""))
            }
            onCommit={(v) =>
              isCreate
                ? set!({ visionModel: v || undefined })
                : mark("adapterConfig", "visionModel", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="model-id (optional)"
          />
        )}
      </Field>

      <Field
        label="orager CLI path"
        hint="Path to the orager binary. Leave blank if orager is on your PATH (npm install -g @paperclipai/orager)."
      >
        <DraftInput
          value={
            isCreate
              ? values!.cliPath ?? ""
              : eff("adapterConfig", "cliPath", String(config.cliPath ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ cliPath: v })
              : mark("adapterConfig", "cliPath", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="orager"
        />
      </Field>

      {/* ===== MODEL ROUTING ===== */}
      <p className={sectionHeadingClass}>Model routing</p>

      <Field
        label="Wake reason → model"
        hint="Route specific Paperclip triggers to different models. E.g. send PR reviews to Claude, quick comments to DeepSeek."
      >
        <div className="space-y-1.5">
          {Object.entries(wakeReasonModels).map(([reason, model]) => (
            <div key={reason} className="flex items-center gap-2 text-sm font-mono">
              <span className="w-28 shrink-0 text-xs text-muted-foreground">
                {reason}
              </span>
              <span className="text-muted-foreground/50">→</span>
              <span className="flex-1 truncate text-xs">{model}</span>
              <button
                type="button"
                aria-label={`Remove ${reason}`}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
                onClick={() => removeWakeReason(reason)}
              >
                Remove
              </button>
            </div>
          ))}
          {unusedWakeReasons.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <select
                className="rounded-md border border-border px-2 py-1 bg-transparent outline-none text-xs font-mono"
                value={newWakeReason}
                onChange={(e) => setNewWakeReason(e.target.value)}
                aria-label="Wake reason"
              >
                <option value="">Select reason…</option>
                {unusedWakeReasons.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <input
                className="flex-1 rounded-md border border-border px-2 py-1 bg-transparent outline-none text-xs font-mono placeholder:text-muted-foreground/40"
                placeholder="model-id"
                value={newWakeModel}
                onChange={(e) => setNewWakeModel(e.target.value)}
                aria-label="Wake reason model"
              />
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:opacity-40"
                onClick={addWakeReason}
                disabled={!newWakeReason || !newWakeModel}
              >
                Add wake reason
              </button>
            </div>
          )}
        </div>
      </Field>

      <Field
        label="Turn model rules"
        hint="Switch models mid-run based on turn count, cumulative cost, or token count. First matching rule wins."
      >
        <div className="space-y-1.5">
          {turnModelRules.map((rule, idx) => (
            <div
              key={idx}
              className="flex items-start gap-2 text-xs font-mono rounded-md border border-border px-2.5 py-1.5"
            >
              <div className="flex-1 min-w-0">
                <span className="font-medium">{rule.model}</span>
                {rule.afterTurn !== undefined && (
                  <span className="text-muted-foreground ml-2">
                    after turn {rule.afterTurn}
                  </span>
                )}
                {rule.costAbove !== undefined && (
                  <span className="text-muted-foreground ml-2">
                    cost &gt; ${rule.costAbove}
                  </span>
                )}
                {rule.tokensAbove !== undefined && (
                  <span className="text-muted-foreground ml-2">
                    tokens &gt; {rule.tokensAbove}
                  </span>
                )}
                {rule.once && (
                  <span className="text-muted-foreground ml-2">(once)</span>
                )}
              </div>
              <button
                type="button"
                aria-label={`Remove rule ${idx}`}
                className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                onClick={() => removeTurnRule(idx)}
              >
                Remove
              </button>
            </div>
          ))}

          {/* New rule inputs */}
          <div className="grid grid-cols-2 gap-1.5 pt-1">
            <input
              className={`col-span-2 rounded-md border border-border px-2 py-1 bg-transparent outline-none text-xs font-mono placeholder:text-muted-foreground/40`}
              placeholder="model-id (required)"
              value={newRuleModel}
              onChange={(e) => setNewRuleModel(e.target.value)}
              aria-label="Rule model"
            />
            <input
              type="number"
              className="rounded-md border border-border px-2 py-1 bg-transparent outline-none text-xs font-mono placeholder:text-muted-foreground/40"
              placeholder="After turn #"
              value={newRuleAfterTurn}
              onChange={(e) =>
                setNewRuleAfterTurn(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              aria-label="Rule after turn"
            />
            <input
              type="number"
              className="rounded-md border border-border px-2 py-1 bg-transparent outline-none text-xs font-mono placeholder:text-muted-foreground/40"
              placeholder="Cost above $"
              value={newRuleCostAbove}
              onChange={(e) =>
                setNewRuleCostAbove(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              aria-label="Rule cost above"
            />
            <input
              type="number"
              className="rounded-md border border-border px-2 py-1 bg-transparent outline-none text-xs font-mono placeholder:text-muted-foreground/40"
              placeholder="Tokens above"
              value={newRuleTokensAbove}
              onChange={(e) =>
                setNewRuleTokensAbove(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              aria-label="Rule tokens above"
            />
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                id="new-rule-once"
                checked={newRuleOnce}
                onChange={(e) => setNewRuleOnce(e.target.checked)}
              />
              <label
                htmlFor="new-rule-once"
                className="text-xs text-muted-foreground"
              >
                Once only
              </label>
            </div>
          </div>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
            onClick={addTurnRule}
            disabled={!newRuleModel}
          >
            + Add rule
          </button>
        </div>
      </Field>

      <Field
        label="Fallback models"
        hint="Fallback model IDs tried in order if the primary model fails (429/503)."
      >
        {(() => {
          const raw = isCreate
            ? values!.models
            : config.models;
          const current: string[] = Array.isArray(raw) ? (raw as string[]) : [];
          const currentDisplay = isCreate
            ? current
            : (eff("adapterConfig", "models", current) as unknown as string[]) ?? current;
          const commitModels = (arr: string[]) =>
            isCreate
              ? set!({ models: arr.length > 0 ? arr : undefined })
              : mark("adapterConfig", "models", arr.length > 0 ? arr : undefined);
          return (
            <div className="space-y-2">
              {currentDisplay.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {currentDisplay.map((id, i) => {
                    const label = models.find((m) => m.id === id)?.label ?? id;
                    return (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-mono"
                      >
                        {label}
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => commitModels(currentDisplay.filter((_, j) => j !== i))}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              {models.length > 0 ? (
                <select
                  aria-label="Add fallback model"
                  className={selectClass}
                  value=""
                  onChange={(e) => {
                    if (e.target.value) commitModels([...currentDisplay, e.target.value]);
                    e.target.value = "";
                  }}
                >
                  <option value="">+ Add fallback model…</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              ) : (
                <DraftInput
                  value={currentDisplay.join(",")}
                  onCommit={(v) => {
                    const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
                    commitModels(arr);
                  }}
                  immediate
                  className={inputClass}
                  placeholder="model-id-1,model-id-2"
                />
              )}
            </div>
          );
        })()}
      </Field>

      <Field
        label="Vision fallback models"
        hint="Model IDs tried when the primary model doesn't support images. Leave blank for defaults (gemini-2.0-flash, gpt-4o, claude-sonnet)."
      >
        {(() => {
          const raw = isCreate
            ? values!.visionFallbackModels
            : config.visionFallbackModels;
          const current: string[] = Array.isArray(raw) ? (raw as string[]) : [];
          const currentDisplay = isCreate
            ? current
            : (eff("adapterConfig", "visionFallbackModels", current) as unknown as string[]) ?? current;
          const commitVisionModels = (arr: string[]) =>
            isCreate
              ? set!({ visionFallbackModels: arr.length > 0 ? arr : undefined })
              : mark("adapterConfig", "visionFallbackModels", arr.length > 0 ? arr : undefined);
          return (
            <div className="space-y-2">
              {currentDisplay.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {currentDisplay.map((id, i) => {
                    const label = models.find((m) => m.id === id)?.label ?? id;
                    return (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-mono"
                      >
                        {label}
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => commitVisionModels(currentDisplay.filter((_, j) => j !== i))}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              {visionModels.length > 0 ? (
                <select
                  aria-label="Add vision fallback model"
                  className={selectClass}
                  value=""
                  onChange={(e) => {
                    if (e.target.value) commitVisionModels([...currentDisplay, e.target.value]);
                    e.target.value = "";
                  }}
                >
                  <option value="">+ Add vision fallback model…</option>
                  {visionModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              ) : (
                <DraftInput
                  value={currentDisplay.join(",")}
                  onCommit={(v) => {
                    const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
                    commitVisionModels(arr);
                  }}
                  immediate
                  className={inputClass}
                  placeholder="google/gemini-2.0-flash-001,openai/gpt-4o"
                />
              )}
            </div>
          );
        })()}
      </Field>

      {/* ===== RUN LIMITS ===== */}
      <p className={sectionHeadingClass}>Run limits</p>

      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun ?? 20}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxTurns",
              Number(config.maxTurns ?? config.maxTurnsPerRun ?? 20),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurns", v || 20)}
            immediate
            className={inputClass}
          />
        )}
      </Field>

      <Field label="Timeout (seconds)" hint={help.timeoutSec}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.timeoutSec ?? 0}
            onChange={(e) => set!({ timeoutSec: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "timeoutSec",
              Number(config.timeoutSec ?? 0),
            )}
            onCommit={(v) => mark("adapterConfig", "timeoutSec", v)}
            immediate
            className={inputClass}
          />
        )}
      </Field>

      <Field
        label="Max Identical Tool Call Turns"
        hint="Turns with identical tool call signature before injecting an anti-loop prompt. Default: 3."
      >
        <DraftNumberInput
          value={
            isCreate
              ? Number(values!.maxIdenticalToolCallTurns ?? 0)
              : eff(
                  "adapterConfig",
                  "maxIdenticalToolCallTurns",
                  Number(config.maxIdenticalToolCallTurns ?? 0),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ maxIdenticalToolCallTurns: v > 0 ? v : undefined })
              : mark("adapterConfig", "maxIdenticalToolCallTurns", v > 0 ? v : undefined)
          }
          immediate
          className={inputClass}
        />
      </Field>

      <Field
        label="Max Spawn Depth"
        hint="Maximum nesting depth for spawned sub-agents. Default: 3. Set to 0 to disable sub-agent spawning."
      >
        <DraftNumberInput
          value={
            isCreate
              ? Number(values!.maxSpawnDepth ?? 0)
              : eff(
                  "adapterConfig",
                  "maxSpawnDepth",
                  Number(config.maxSpawnDepth ?? 0),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ maxSpawnDepth: v >= 0 ? v : undefined })
              : mark("adapterConfig", "maxSpawnDepth", v >= 0 ? v : undefined)
          }
          immediate
          className={inputClass}
        />
      </Field>

      <Field
        label="Approval Mode"
        hint="Controls tool approval. 'question' pauses for user input; 'auto' approves all."
      >
        <select
          aria-label="Approval Mode"
          className={selectClass}
          value={
            isCreate
              ? (values!.approvalMode as string) ?? ""
              : eff("adapterConfig", "approvalMode", String(config.approvalMode ?? ""))
          }
          onChange={(e) =>
            isCreate
              ? set!({ approvalMode: e.target.value || undefined })
              : mark("adapterConfig", "approvalMode", e.target.value || undefined)
          }
        >
          <option value="">Default</option>
          <option value="question">question</option>
          <option value="auto">auto</option>
        </select>
      </Field>

      <Field
        label="Approval Timeout (ms)"
        hint="How long to wait for user approval before timing out. Default: no timeout."
      >
        <DraftNumberInput
          value={
            isCreate
              ? Number(values!.approvalTimeoutMs ?? 0)
              : eff(
                  "adapterConfig",
                  "approvalTimeoutMs",
                  Number(config.approvalTimeoutMs ?? 0),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ approvalTimeoutMs: v > 0 ? v : undefined })
              : mark("adapterConfig", "approvalTimeoutMs", v > 0 ? v : undefined)
          }
          immediate
          className={inputClass}
        />
      </Field>

      <Field
        label="Max cost (USD)"
        hint="Hard stop. Abort the run if accumulated cost exceeds this USD amount."
      >
        <DraftNumberInput
          value={
            isCreate
              ? Number(values!.maxCostUsd ?? 0)
              : eff(
                  "adapterConfig",
                  "maxCostUsd",
                  Number(config.maxCostUsd ?? 0),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ maxCostUsd: v > 0 ? v : undefined })
              : mark("adapterConfig", "maxCostUsd", v > 0 ? v : undefined)
          }
          immediate
          className={inputClass}
        />
      </Field>

      <Field
        label="Cost soft limit (USD)"
        hint="Log a warning when a single run exceeds this cost. Does not stop the run — use Max cost USD for a hard stop."
      >
        <DraftNumberInput
          value={eff(
            "adapterConfig",
            "maxCostUsdSoft",
            Number(config.maxCostUsdSoft ?? 0),
          )}
          onCommit={(v) =>
            mark("adapterConfig", "maxCostUsdSoft", v > 0 ? v : undefined)
          }
          immediate
          className={inputClass}
        />
      </Field>

      {/* ===== CONTEXT ===== */}
      <p className={sectionHeadingClass}>Context</p>

      <Field
        label="Summarize at (0–1)"
        hint="Fraction of context window at which session history is summarized and compacted (e.g. 0.8 = 80%). Leave blank to disable. The 500-message hard cap always applies regardless of this setting."
      >
        <DraftNumberInput
          value={eff(
            "adapterConfig",
            "summarizeAt",
            Number(config.summarizeAt ?? 0),
          )}
          onCommit={(v) =>
            mark("adapterConfig", "summarizeAt", v > 0 ? v : undefined)
          }
          immediate
          className={inputClass}
        />
      </Field>

      <Field
        label="Summarize model"
        hint="Model used for session summarization. Defaults to the primary model. A cheap fast model works well here."
      >
        {models.length > 0 ? (
          <select
            aria-label="Summarize model"
            className={selectClass}
            value={eff(
              "adapterConfig",
              "summarizeModel",
              String(config.summarizeModel ?? ""),
            )}
            onChange={(e) =>
              mark("adapterConfig", "summarizeModel", e.target.value || undefined)
            }
          >
            <option value="">Default (use primary model)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        ) : (
          <DraftInput
            value={eff(
              "adapterConfig",
              "summarizeModel",
              String(config.summarizeModel ?? ""),
            )}
            onCommit={(v) =>
              mark("adapterConfig", "summarizeModel", v || undefined)
            }
            immediate
            className={inputClass}
            placeholder="deepseek/deepseek-chat-v3-0324"
          />
        )}
      </Field>

      {/* ===== PROMPTS ===== */}
      <p className={sectionHeadingClass}>Prompts</p>

      <Field
        label="Bootstrap prompt"
        hint="Sent only on the first run (no prior session). Supports {{agent.name}}, {{context.wakeReason}}, and other template variables."
      >
        <DraftTextarea
          value={
            isCreate
              ? String(values!.bootstrapPromptTemplate ?? "")
              : eff(
                  "adapterConfig",
                  "bootstrapPromptTemplate",
                  String(config.bootstrapPromptTemplate ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ bootstrapPromptTemplate: v || undefined })
              : mark(
                  "adapterConfig",
                  "bootstrapPromptTemplate",
                  v || undefined,
                )
          }
          immediate
          placeholder="You are {{agent.name}}. This is your first run…"
          minRows={3}
        />
      </Field>

      <ToggleField
        label="Read Project Instructions"
        hint="When enabled, orager reads CLAUDE.md / project instruction files from the workspace and injects them into the system prompt."
        checked={
          isCreate
            ? (values!.readProjectInstructions as boolean) ?? true
            : eff("adapterConfig", "readProjectInstructions", config.readProjectInstructions !== false)
        }
        onChange={(v) =>
          isCreate
            ? set!({ readProjectInstructions: v })
            : mark("adapterConfig", "readProjectInstructions", v)
        }
      />

      <Field
        label="Instructions file path"
        hint="Path to a file appended to the system prompt. Must resolve within the agent's working directory (symlinks are resolved before validation)."
      >
        <DraftInput
          value={
            isCreate
              ? String(values!.instructionsFilePath ?? "")
              : eff(
                  "adapterConfig",
                  "instructionsFilePath",
                  String(config.instructionsFilePath ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ instructionsFilePath: v || undefined })
              : mark("adapterConfig", "instructionsFilePath", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="AGENT_INSTRUCTIONS.md"
        />
      </Field>

      <Field
        label="Required env vars"
        hint="Comma-separated env var names. The agent fails immediately with a clear error if any are missing at run start."
      >
        <DraftInput
          value={
            isCreate
              ? Array.isArray(values!.requiredEnvVars)
                ? (values!.requiredEnvVars as string[]).join(",")
                : ""
              : eff(
                  "adapterConfig",
                  "requiredEnvVars",
                  Array.isArray(config.requiredEnvVars)
                    ? (config.requiredEnvVars as string[]).join(",")
                    : "",
                )
          }
          onCommit={(v) => {
            const arr = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            return isCreate
              ? set!({ requiredEnvVars: arr.length > 0 ? arr : undefined })
              : mark(
                  "adapterConfig",
                  "requiredEnvVars",
                  arr.length > 0 ? arr : undefined,
                );
          }}
          immediate
          className={inputClass}
          placeholder="GITHUB_TOKEN,LINEAR_API_KEY"
        />
      </Field>

      {/* ===== REASONING (collapsible, only for models that support extended thinking) ===== */}
      {selectedModelSupportsReasoning && <details>
        <summary className="text-xs font-medium text-muted-foreground cursor-pointer py-2 select-none hover:text-foreground transition-colors">
          Reasoning (extended thinking)
        </summary>
        <div className="space-y-3 pt-1 pb-2">
          <Field
            label="Reasoning effort"
            hint="Allocates a reasoning token budget: xhigh≈95%, high≈80%, medium≈50%, low≈20%, minimal≈10%, none=disabled."
          >
            <select
              className={selectClass}
              value={reasoning.effort ?? ""}
              onChange={(e) => {
                const v = e.target.value as ReasoningConfig["effort"] | "";
                commitReasoning({ effort: v || undefined });
              }}
            >
              <option value="">Default (none)</option>
              <option value="xhigh">xhigh</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
              <option value="minimal">minimal</option>
              <option value="none">none</option>
            </select>
          </Field>

          <Field
            label="Reasoning max tokens"
            hint="Maximum reasoning token budget. Leave 0 to let the effort level decide."
          >
            <DraftNumberInput
              value={reasoning.max_tokens ?? 0}
              onCommit={(v) =>
                commitReasoning({ max_tokens: v > 0 ? v : undefined })
              }
              immediate
              className={inputClass}
            />
          </Field>
        </div>
      </details>}

      {/* ===== PROVIDER ROUTING (collapsible) ===== */}
      <details>
        <summary className="text-xs font-medium text-muted-foreground cursor-pointer py-2 select-none hover:text-foreground transition-colors">
          Provider routing
        </summary>
        <div className="space-y-3 pt-1 pb-2">
          <Field
            label="Provider order"
            hint="Preferred provider priority. First provider is tried first."
          >
            {(() => {
              const current = provider.order ?? [];
              return (
                <div className="space-y-2">
                  {current.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {current.map((slug, i) => (
                        <span key={i} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-mono">
                          {slug}
                          <button type="button" className="text-muted-foreground hover:text-foreground"
                            onClick={() => commitProvider({ order: current.filter((_, j) => j !== i) })}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <select aria-label="Add provider to order" className={selectClass} value=""
                    onChange={(e) => { if (e.target.value) commitProvider({ order: [...current, e.target.value] }); e.target.value = ""; }}
                  >
                    <option value="">+ Add provider…</option>
                    {PROVIDER_SLUGS.filter((s) => !current.includes(s)).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              );
            })()}
          </Field>

          <Field
            label="Provider allowlist"
            hint="Only these providers will be used."
          >
            {(() => {
              const current = provider.only ?? [];
              return (
                <div className="space-y-2">
                  {current.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {current.map((slug, i) => (
                        <span key={i} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-mono">
                          {slug}
                          <button type="button" className="text-muted-foreground hover:text-foreground"
                            onClick={() => commitProvider({ only: current.filter((_, j) => j !== i) })}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <select aria-label="Add provider to allowlist" className={selectClass} value=""
                    onChange={(e) => { if (e.target.value) commitProvider({ only: [...current, e.target.value] }); e.target.value = ""; }}
                  >
                    <option value="">+ Add provider…</option>
                    {PROVIDER_SLUGS.filter((s) => !current.includes(s)).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              );
            })()}
          </Field>

          <Field
            label="Provider blocklist"
            hint="These providers will be excluded."
          >
            {(() => {
              const current = provider.ignore ?? [];
              return (
                <div className="space-y-2">
                  {current.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {current.map((slug, i) => (
                        <span key={i} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-mono">
                          {slug}
                          <button type="button" className="text-muted-foreground hover:text-foreground"
                            onClick={() => commitProvider({ ignore: current.filter((_, j) => j !== i) })}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <select aria-label="Add provider to blocklist" className={selectClass} value=""
                    onChange={(e) => { if (e.target.value) commitProvider({ ignore: [...current, e.target.value] }); e.target.value = ""; }}
                  >
                    <option value="">+ Add provider…</option>
                    {PROVIDER_SLUGS.filter((s) => !current.includes(s)).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              );
            })()}
          </Field>

          <Field
            label="Data collection"
            hint="Set to 'deny' to exclude providers that train on your data."
          >
            <select
              className={selectClass}
              value={provider.data_collection ?? ""}
              onChange={(e) => {
                const v = e.target.value as "deny" | "";
                commitProvider({ data_collection: v || undefined });
              }}
            >
              <option value="">(default)</option>
              <option value="deny">deny</option>
            </select>
          </Field>

          <ToggleField
            label="Zero Data Retention only"
            hint="Only route to providers that guarantee zero data retention."
            checked={provider.zdr === true}
            onChange={(v) => commitProvider({ zdr: v || undefined })}
          />

          <Field
            label="Provider sort"
            hint="How to rank providers when no explicit order is set. Default: latency (minimizes TTFT)."
          >
            <select
              className={selectClass}
              value={provider.sort ?? ""}
              onChange={(e) => {
                const v = e.target.value as ProviderConfig["sort"] | "";
                commitProvider({ sort: v || undefined });
              }}
            >
              <option value="">(default: latency)</option>
              <option value="latency">latency</option>
              <option value="price">price</option>
              <option value="throughput">throughput</option>
            </select>
          </Field>
        </div>
      </details>

      {/* ===== TOOL CONTROL ===== */}
      <p className={sectionHeadingClass}>Tool control</p>

      <ToggleField
        label="Parallel tool calls"
        hint="Execute multiple tool calls concurrently within a single turn. Enabled by default."
        checked={
          isCreate
            ? (values!.parallel_tool_calls as boolean) ?? true
            : eff(
                "adapterConfig",
                "parallel_tool_calls",
                config.parallel_tool_calls !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ parallel_tool_calls: v })
            : mark("adapterConfig", "parallel_tool_calls", v)
        }
      />

      <Field
        label="Sandbox root"
        hint="Restrict file operations to this directory. Useful for isolating agents that should not access files outside the project."
      >
        <DraftInput
          value={
            isCreate
              ? String(values!.sandboxRoot ?? "")
              : eff(
                  "adapterConfig",
                  "sandboxRoot",
                  String(config.sandboxRoot ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ sandboxRoot: v || undefined })
              : mark("adapterConfig", "sandboxRoot", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/path/to/project"
        />
      </Field>

      <ToggleField
        label="Use finish tool"
        hint="Model calls a finish tool to explicitly signal completion instead of stopping on its own."
        checked={
          isCreate
            ? (values!.useFinishTool as boolean) ?? false
            : eff(
                "adapterConfig",
                "useFinishTool",
                config.useFinishTool === true,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ useFinishTool: v })
            : mark("adapterConfig", "useFinishTool", v)
        }
      />

      {/* ===== MEMORY ===== */}
      <p className={sectionHeadingClass}>Memory</p>

      <Field
        label="Memory Retrieval Mode"
        hint="local = term overlap (fast, no API cost). embedding = cosine similarity over cached vectors (more accurate, requires an embedding model)."
      >
        <select
          aria-label="Memory Retrieval Mode"
          className={selectClass}
          value={
            isCreate
              ? (values!.memoryRetrieval as string) ?? "local"
              : eff("adapterConfig", "memoryRetrieval", String(config.memoryRetrieval ?? "local"))
          }
          onChange={(e) =>
            isCreate
              ? set!({ memoryRetrieval: e.target.value || "local" })
              : mark("adapterConfig", "memoryRetrieval", e.target.value || "local")
          }
        >
          <option value="local">local — term overlap</option>
          <option value="embedding">embedding — cosine similarity</option>
        </select>
      </Field>

      <Field
        label="Embedding Model"
        hint="Embedding model for memory retrieval. Only used when Memory Retrieval Mode is 'embedding'."
      >
        <select
          aria-label="Embedding Model"
          className={selectClass}
          value={
            isCreate
              ? String(values!.memoryEmbeddingModel ?? "")
              : eff("adapterConfig", "memoryEmbeddingModel", String(config.memoryEmbeddingModel ?? ""))
          }
          onChange={(e) =>
            isCreate
              ? set!({ memoryEmbeddingModel: e.target.value || undefined })
              : mark("adapterConfig", "memoryEmbeddingModel", e.target.value || undefined)
          }
        >
          <option value="">Default (openai/text-embedding-3-small)</option>
          {EMBEDDING_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </Field>

      <Field
        label="Memory Max Chars"
        hint="Maximum characters of memory injected into the system prompt. Default: 6000."
      >
        <DraftNumberInput
          value={
            isCreate
              ? Number(values!.memoryMaxChars ?? 0)
              : eff(
                  "adapterConfig",
                  "memoryMaxChars",
                  Number(config.memoryMaxChars ?? 0),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ memoryMaxChars: v > 0 ? v : undefined })
              : mark("adapterConfig", "memoryMaxChars", v > 0 ? v : undefined)
          }
          immediate
          className={inputClass}
        />
      </Field>

    </>
  );
}
