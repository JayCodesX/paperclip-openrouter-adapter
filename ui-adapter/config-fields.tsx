import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function OpenRouterConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  return (
    <>
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
            className={inputClass}
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
            value={eff("adapterConfig", "timeoutSec", Number(config.timeoutSec ?? 0))}
            onCommit={(v) => mark("adapterConfig", "timeoutSec", v)}
            immediate
            className={inputClass}
          />
        )}
      </Field>

      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions ?? false
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

      <Field
        label="Fallback models"
        hint="Comma-separated list of fallback model IDs tried in order if the primary model fails (429/503). E.g.: deepseek/deepseek-chat-v3-0324:nitro,anthropic/claude-haiku-4-5"
      >
        <DraftInput
          value={
            isCreate
              ? (Array.isArray(values!.models) ? (values!.models as string[]).join(",") : "")
              : eff("adapterConfig", "models", Array.isArray(config.models) ? (config.models as string[]).join(",") : "")
          }
          onCommit={(v) => {
            const arr = v.split(",").map((s) => s.trim()).filter(Boolean);
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
        label="Summarize at (0–1)"
        hint="Fraction of context window at which session history is summarized and compacted (e.g. 0.8 = 80%). Leave blank to disable. The 500-message hard cap always applies regardless of this setting."
      >
        <DraftNumberInput
          value={eff("adapterConfig", "summarizeAt", Number(config.summarizeAt ?? 0))}
          onCommit={(v) => mark("adapterConfig", "summarizeAt", v > 0 ? v : undefined)}
          immediate
          className={inputClass}
        />
      </Field>

      <Field
        label="Summarize model"
        hint="Model used for session summarization. Defaults to the primary model. A cheap fast model (e.g. deepseek/deepseek-chat-v3-0324) works well here."
      >
        <DraftInput
          value={eff("adapterConfig", "summarizeModel", String(config.summarizeModel ?? ""))}
          onCommit={(v) => mark("adapterConfig", "summarizeModel", v || undefined)}
          immediate
          className={inputClass}
          placeholder="deepseek/deepseek-chat-v3-0324"
        />
      </Field>

      <Field
        label="Cost soft limit (USD)"
        hint="Log a warning when a single run exceeds this cost. Does not stop the run — use Max cost USD for a hard stop."
      >
        <DraftNumberInput
          value={eff("adapterConfig", "maxCostUsdSoft", Number(config.maxCostUsdSoft ?? 0))}
          onCommit={(v) => mark("adapterConfig", "maxCostUsdSoft", v > 0 ? v : undefined)}
          immediate
          className={inputClass}
        />
      </Field>

      <ToggleField
        label="Dry run"
        hint="When enabled, the adapter logs what it would do but makes no API calls. Use to verify config without spending tokens."
        checked={
          isCreate
            ? values!.dryRun ?? false
            : eff("adapterConfig", "dryRun", config.dryRun === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ dryRun: v })
            : mark("adapterConfig", "dryRun", v)
        }
      />
    </>
  );
}
