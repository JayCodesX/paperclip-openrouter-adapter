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
    </>
  );
}
