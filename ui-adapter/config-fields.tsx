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
        hint="Comma-separated list of fallback model IDs tried in order if the primary model fails (429/503). E.g.: deepseek/deepseek-chat-v3-0324:nitro,anthropic/claude-haiku-4-5"
      >
        <DraftInput
          value={
            isCreate
              ? Array.isArray(values!.models)
                ? (values!.models as string[]).join(",")
                : ""
              : eff(
                  "adapterConfig",
                  "models",
                  Array.isArray(config.models)
                    ? (config.models as string[]).join(",")
                    : "",
                )
          }
          onCommit={(v) => {
            const arr = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            return isCreate
              ? set!({ models: arr.length > 0 ? arr : undefined })
              : mark("adapterConfig", "models", arr.length > 0 ? arr : undefined);
          }}
          immediate
          className={inputClass}
          placeholder="model-id-1,model-id-2"
        />
      </Field>

      <Field
        label="Vision fallback models"
        hint={`Comma-separated model IDs tried in order when the primary model doesn't support image inputs. Leave blank to use the default chain: google/gemini-2.0-flash-001, openai/gpt-4o, anthropic/claude-sonnet-4-5. Set to a single space to disable fallback entirely.`}
      >
        <DraftInput
          value={
            isCreate
              ? Array.isArray(values!.visionFallbackModels)
                ? (values!.visionFallbackModels as string[]).join(",")
                : ""
              : eff(
                  "adapterConfig",
                  "visionFallbackModels",
                  Array.isArray(config.visionFallbackModels)
                    ? (config.visionFallbackModels as string[]).join(",")
                    : "",
                )
          }
          onCommit={(v) => {
            const arr = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            return isCreate
              ? set!({ visionFallbackModels: arr.length > 0 ? arr : undefined })
              : mark("adapterConfig", "visionFallbackModels", arr.length > 0 ? arr : undefined);
          }}
          immediate
          className={inputClass}
          placeholder="google/gemini-2.0-flash-001,openai/gpt-4o"
        />
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

      {/* ===== DAEMON ===== */}
      <p className={sectionHeadingClass}>Daemon</p>

      <Field
        label="Daemon URL"
        hint="Override daemon URL (e.g. http://127.0.0.1:3456). Also read from ORAGER_DAEMON_URL env var."
      >
        <DraftInput
          value={
            isCreate
              ? String(values!.daemonUrl ?? "")
              : eff(
                  "adapterConfig",
                  "daemonUrl",
                  String(config.daemonUrl ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ daemonUrl: v || undefined })
              : mark("adapterConfig", "daemonUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://127.0.0.1:3456"
        />
      </Field>

      <Field
        label="API key pool"
        hint="Additional OpenRouter API keys, comma-separated. On 429, orager rotates through these mid-run before escalating to model fallback. The primary API key is always first."
      >
        <DraftInput
          value={
            isCreate
              ? Array.isArray(values!.apiKeys)
                ? (values!.apiKeys as string[]).join(",")
                : ""
              : eff(
                  "adapterConfig",
                  "apiKeys",
                  Array.isArray(config.apiKeys)
                    ? (config.apiKeys as string[]).join(",")
                    : "",
                )
          }
          onCommit={(v) => {
            const arr = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            return isCreate
              ? set!({ apiKeys: arr.length > 0 ? arr : undefined })
              : mark("adapterConfig", "apiKeys", arr.length > 0 ? arr : undefined);
          }}
          immediate
          className={inputClass}
          placeholder="sk-or-key2,sk-or-key3"
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
        hint="Model used for session summarization. Defaults to the primary model. A cheap fast model (e.g. deepseek/deepseek-chat-v3-0324) works well here."
      >
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

      {/* ===== SAMPLING (collapsible) ===== */}
      <details>
        <summary className="text-xs font-medium text-muted-foreground cursor-pointer py-2 select-none hover:text-foreground transition-colors">
          Sampling
        </summary>
        <div className="space-y-3 pt-1 pb-2">
          <Field
            label="Temperature (0.0–2.0)"
            hint="Controls response randomness. Lower values are more deterministic, higher values more creative."
          >
            <DraftNumberInput
              value={
                isCreate
                  ? Number(values!.temperature ?? 0)
                  : eff(
                      "adapterConfig",
                      "temperature",
                      Number(config.temperature ?? 0),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ temperature: v > 0 ? v : undefined })
                  : mark("adapterConfig", "temperature", v > 0 ? v : undefined)
              }
              immediate
              className={inputClass}
            />
          </Field>

          <Field
            label="Top P (0.0–1.0)"
            hint="Nucleus sampling threshold. Only consider tokens comprising the top P probability mass."
          >
            <DraftNumberInput
              value={
                isCreate
                  ? Number(values!.top_p ?? 0)
                  : eff("adapterConfig", "top_p", Number(config.top_p ?? 0))
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ top_p: v > 0 ? v : undefined })
                  : mark("adapterConfig", "top_p", v > 0 ? v : undefined)
              }
              immediate
              className={inputClass}
            />
          </Field>

          <Field label="Seed" hint="Integer seed for reproducible outputs.">
            <DraftNumberInput
              value={
                isCreate
                  ? Number(values!.seed ?? 0)
                  : eff("adapterConfig", "seed", Number(config.seed ?? 0))
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ seed: v !== 0 ? v : undefined })
                  : mark("adapterConfig", "seed", v !== 0 ? v : undefined)
              }
              immediate
              className={inputClass}
            />
          </Field>

          <Field
            label="Stop sequences"
            hint="Comma-separated stop sequences. Generation halts when any of these strings is encountered."
          >
            <DraftInput
              value={
                isCreate
                  ? Array.isArray(values!.stop)
                    ? (values!.stop as string[]).join(",")
                    : ""
                  : eff(
                      "adapterConfig",
                      "stop",
                      Array.isArray(config.stop)
                        ? (config.stop as string[]).join(",")
                        : "",
                    )
              }
              onCommit={(v) => {
                const arr = v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                return isCreate
                  ? set!({ stop: arr.length > 0 ? arr : undefined })
                  : mark(
                      "adapterConfig",
                      "stop",
                      arr.length > 0 ? arr : undefined,
                    );
              }}
              immediate
              className={inputClass}
              placeholder="</s>,<|end|>"
            />
          </Field>

          <Field
            label="Repetition penalty (0.0–2.0)"
            hint="OpenRouter repetition penalty. Values above 1.0 discourage repeated tokens."
          >
            <DraftNumberInput
              value={
                isCreate
                  ? Number(values!.repetition_penalty ?? 0)
                  : eff(
                      "adapterConfig",
                      "repetition_penalty",
                      Number(config.repetition_penalty ?? 0),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ repetition_penalty: v > 0 ? v : undefined })
                  : mark(
                      "adapterConfig",
                      "repetition_penalty",
                      v > 0 ? v : undefined,
                    )
              }
              immediate
              className={inputClass}
            />
          </Field>

          <Field
            label="Frequency penalty"
            hint="Frequency-based token penalty. Positive values reduce repetition of frequent tokens."
          >
            <DraftNumberInput
              value={
                isCreate
                  ? Number(values!.frequency_penalty ?? 0)
                  : eff(
                      "adapterConfig",
                      "frequency_penalty",
                      Number(config.frequency_penalty ?? 0),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ frequency_penalty: v !== 0 ? v : undefined })
                  : mark(
                      "adapterConfig",
                      "frequency_penalty",
                      v !== 0 ? v : undefined,
                    )
              }
              immediate
              className={inputClass}
            />
          </Field>

          <Field
            label="Presence penalty"
            hint="Presence-based token penalty. Positive values encourage the model to discuss new topics."
          >
            <DraftNumberInput
              value={
                isCreate
                  ? Number(values!.presence_penalty ?? 0)
                  : eff(
                      "adapterConfig",
                      "presence_penalty",
                      Number(config.presence_penalty ?? 0),
                    )
              }
              onCommit={(v) =>
                isCreate
                  ? set!({ presence_penalty: v !== 0 ? v : undefined })
                  : mark(
                      "adapterConfig",
                      "presence_penalty",
                      v !== 0 ? v : undefined,
                    )
              }
              immediate
              className={inputClass}
            />
          </Field>

          {/* Advanced cost overrides — nested within Sampling for discoverability */}
          <details>
            <summary className="text-xs text-muted-foreground/60 cursor-pointer py-1 select-none hover:text-muted-foreground transition-colors">
              Advanced cost overrides
            </summary>
            <div className="space-y-3 pt-2">
              <Field
                label="Cost per input token"
                hint="Override OpenRouter's pricing data for input tokens. Only needed if OpenRouter reports incorrect costs for this model."
              >
                <DraftNumberInput
                  value={
                    isCreate
                      ? Number(values!.costPerInputToken ?? 0)
                      : eff(
                          "adapterConfig",
                          "costPerInputToken",
                          Number(config.costPerInputToken ?? 0),
                        )
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ costPerInputToken: v > 0 ? v : undefined })
                      : mark(
                          "adapterConfig",
                          "costPerInputToken",
                          v > 0 ? v : undefined,
                        )
                  }
                  immediate
                  className={inputClass}
                />
              </Field>

              <Field
                label="Cost per output token"
                hint="Override OpenRouter's pricing data for output tokens."
              >
                <DraftNumberInput
                  value={
                    isCreate
                      ? Number(values!.costPerOutputToken ?? 0)
                      : eff(
                          "adapterConfig",
                          "costPerOutputToken",
                          Number(config.costPerOutputToken ?? 0),
                        )
                  }
                  onCommit={(v) =>
                    isCreate
                      ? set!({ costPerOutputToken: v > 0 ? v : undefined })
                      : mark(
                          "adapterConfig",
                          "costPerOutputToken",
                          v > 0 ? v : undefined,
                        )
                  }
                  immediate
                  className={inputClass}
                />
              </Field>
            </div>
          </details>
        </div>
      </details>

      {/* ===== REASONING (collapsible) ===== */}
      <details>
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

          <ToggleField
            label="Include reasoning in response"
            hint="When on, reasoning tokens are included in the response. Off by default (exclude: true) to save cost."
            checked={reasoning.exclude === false}
            onChange={(v) => commitReasoning({ exclude: !v })}
          />

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
      </details>

      {/* ===== PROVIDER ROUTING (collapsible) ===== */}
      <details>
        <summary className="text-xs font-medium text-muted-foreground cursor-pointer py-2 select-none hover:text-foreground transition-colors">
          Provider routing
        </summary>
        <div className="space-y-3 pt-1 pb-2">
          <Field
            label="Provider order"
            hint="Comma-separated preferred provider slugs. E.g. DeepSeek,Together"
          >
            <DraftInput
              value={(provider.order ?? []).join(",")}
              onCommit={(v) => {
                const arr = v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                commitProvider({ order: arr.length > 0 ? arr : undefined });
              }}
              immediate
              className={inputClass}
              placeholder="DeepSeek,Together"
            />
          </Field>

          <Field
            label="Provider allowlist"
            hint="Comma-separated provider slugs. Only these providers will be used."
          >
            <DraftInput
              value={(provider.only ?? []).join(",")}
              onCommit={(v) => {
                const arr = v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                commitProvider({ only: arr.length > 0 ? arr : undefined });
              }}
              immediate
              className={inputClass}
              placeholder="DeepSeek"
            />
          </Field>

          <Field
            label="Provider blocklist"
            hint="Comma-separated provider slugs to exclude."
          >
            <DraftInput
              value={(provider.ignore ?? []).join(",")}
              onCommit={(v) => {
                const arr = v
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
                commitProvider({ ignore: arr.length > 0 ? arr : undefined });
              }}
              immediate
              className={inputClass}
              placeholder="Azure"
            />
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
        hint="OpenRouter embedding model ID (e.g. openai/text-embedding-3-small). Only used when Memory Retrieval Mode is 'embedding'."
      >
        <DraftInput
          value={
            isCreate
              ? String(values!.memoryEmbeddingModel ?? "")
              : eff("adapterConfig", "memoryEmbeddingModel", String(config.memoryEmbeddingModel ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ memoryEmbeddingModel: v || undefined })
              : mark("adapterConfig", "memoryEmbeddingModel", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="openai/text-embedding-3-small"
        />
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

      {/* ===== DEV / DEBUG ===== */}
      <p className={sectionHeadingClass}>Dev / debug</p>

      <ToggleField
        label="Dry run"
        hint="When enabled, the adapter logs what it would do but makes no API calls. Use to verify config without spending tokens."
        checked={
          isCreate
            ? (values!.dryRun as boolean) ?? false
            : eff("adapterConfig", "dryRun", config.dryRun === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ dryRun: v })
            : mark("adapterConfig", "dryRun", v)
        }
      />

      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? (values!.dangerouslySkipPermissions as boolean) ?? false
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions === true,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
    </>
  );
}
