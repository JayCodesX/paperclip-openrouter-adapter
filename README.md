# openrouter-local — Paperclip adapter

Adds **OpenRouter-backed agent loops** to [Paperclip](https://paperclipai.com) using the [`orager`](https://github.com/JayCodesX/orager) CLI — works with any OpenRouter model (DeepSeek, GPT-4o, Gemini, Anthropic, Llama, and 300+ more).

---

## How it works

```
Paperclip
    │  execute(ctx)
    ▼
execute-cli.ts
    │  spawn("orager", [...args])
    │  write prompt → stdin
    ▼
orager process
    │  calls OpenRouter API (multi-turn)
    │  executes tools: bash, read_file, write_file, str_replace, list_dir, web_fetch
    │  emits stream-json events on stdout
    ▼
execute-cli.ts reads stdout
    │  streams each line to ctx.onLog("stdout", line)
    │  captures session_id, usage, cost
    ▼
AdapterExecutionResult
    { exitCode, summary, sessionParams: { oragerSessionId }, usage, totalCostUsd }
```

Sessions are resumed automatically across runs — Paperclip stores the orager session ID in `sessionParams` and passes it back via `--resume` on the next run.

---

## Prerequisites

```bash
npm install -g @paperclipai/orager   # install orager CLI
export OPENROUTER_API_KEY=sk-or-...  # or set per-agent in the adapter config
```

---

## Install into Paperclip

Run from the **Paperclip repo root**:

```bash
bash /path/to/paperclip-openrouter-adapter/install.sh
```

The script:
1. Copies `openrouter/` → `packages/adapters/openrouter/`
2. Copies `ui-adapter/` → `ui/src/adapters/openrouter/`
3. Patches `server/src/adapters/registry.ts`
4. Patches `ui/src/adapters/registry.ts`
5. Patches `cli/src/adapters/registry.ts`
6. Runs `pnpm install`

All patches are idempotent — safe to run more than once.

Restart Paperclip → **OpenRouter (orager)** appears in the adapter dropdown.

---

## Files

```
paperclip-openrouter-adapter/
├── README.md
├── install.sh            one-command install (run from Paperclip root)
│
├── openrouter/           adapter package (@paperclipai/adapter-openrouter)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              adapter identity, models, sessionCodec
│       ├── server/
│       │   ├── index.ts          exports execute (= executeAgentLoop), testEnvironment
│       │   ├── execute-cli.ts    spawns orager, streams events, handles timeout/resume
│       │   └── test.ts           env validation: API key, connectivity, orager binary, hello probe
│       ├── ui/
│       │   ├── index.ts
│       │   ├── parse-stdout.ts   converts orager stream-json → TranscriptEntry[]
│       │   └── build-config.ts   config builder with agent-loop defaults
│       └── cli/
│           ├── index.ts
│           └── format-event.ts   formats orager events for the Paperclip CLI
│
└── ui-adapter/           React UI module (copied to ui/src/adapters/openrouter/)
    ├── index.ts              UIAdapterModule definition
    └── config-fields.tsx     config form: API key, model, cliPath, maxTurns, etc.
```

---

## Configuration reference

All fields go in the agent's adapter config block. Only `apiKey` is required (or set `OPENROUTER_API_KEY` in the server environment).

### Core

| Field | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string | — | **Required.** OpenRouter API key. Use a `secret_ref` in production. |
| `model` | string | `deepseek/deepseek-chat-v3-2` | Any OpenRouter model ID. |
| `models` | string[] | — | Fallback models tried in order if the primary fails. |
| `systemPrompt` | string | built-in | System prompt template. Supports `{{agent.id}}`, `{{agent.name}}`, etc. |
| `promptTemplate` | string | built-in | User message sent every run. Same template variables available. |
| `bootstrapPromptTemplate` | string | — | Sent only on the first run (no prior session). Use for stable setup instructions. |
| `maxTurns` / `maxTurnsPerRun` | number | `20` | Maximum agent turns per run. |
| `maxRetries` | number | `3` | API retries on transient errors. |
| `timeoutSec` | number | `300` | Total timeout in seconds. `0` = unlimited. |
| `graceSec` | number | `20` | Seconds between SIGTERM and SIGKILL on timeout. |
| `cliPath` | string | `orager` | Path to orager binary if not on PATH. |
| `cwd` | string | `process.cwd()` | Working directory for the spawned process. |
| `siteUrl` | string | — | HTTP-Referer header for OpenRouter attribution. |
| `siteName` | string | — | X-Title header for OpenRouter attribution. |
| `env` | object | — | Extra environment variables passed to the subprocess. |

### Sampling

| Field | Type | Description |
|---|---|---|
| `temperature` | number | Response randomness (0.0–2.0). |
| `top_p` | number | Nucleus sampling threshold (0.0–1.0). |
| `top_k` | integer | Token selection pool size. |
| `frequency_penalty` | number | Frequency-based token penalty (-2.0–2.0). |
| `presence_penalty` | number | Presence-based token penalty (-2.0–2.0). |
| `repetition_penalty` | number | OpenRouter repetition penalty (0.0–2.0). |
| `min_p` | number | Minimum probability relative to top token (0.0–1.0). |
| `seed` | integer | Seed for reproducible outputs. |
| `stop` | string[] | Stop sequences. |

### Reasoning (extended thinking)

For DeepSeek R1, Claude with extended thinking, OpenAI o3, Gemini 2.5 Pro.

```yaml
reasoning:
  effort: high          # xhigh | high | medium | low | minimal | none
  max_tokens: 8000      # exact reasoning token budget (Anthropic, Gemini, Alibaba)
  exclude: false        # run reasoning internally but omit from response
```

`effort` allocates a percentage of `maxTokens`: `xhigh` ≈ 95%, `high` ≈ 80%, `medium` ≈ 50%, `low` ≈ 20%, `minimal` ≈ 10%.

### Provider routing

```yaml
provider:
  order: ["DeepSeek", "Together"]   # preferred provider slugs
  allow_fallbacks: true             # fall back if preferred unavailable
  require_parameters: false         # only route to providers supporting all params
  data_collection: deny             # exclude providers that train on your data
  zdr: true                         # Zero Data Retention providers only
  only: ["DeepSeek"]                # provider allowlist
  ignore: ["Azure"]                 # provider blocklist
  quantizations: ["fp16", "bf16"]   # filter by quantization
  sort: price                       # price | throughput | latency
```

### Agent loop options

| Field | Type | Description |
|---|---|---|
| `dangerouslySkipPermissions` | boolean | Pass `--dangerously-skip-permissions`. Skips all tool approval prompts. |
| `useFinishTool` | boolean | Model calls a `finish` tool to signal completion. |
| `requireApproval` | boolean | Require human approval before any tool runs. |
| `requireApprovalFor` | string | Comma-separated list of tools that require approval. |
| `maxCostUsd` | number | Stop if accumulated cost exceeds this USD value. |
| `costPerInputToken` | number | Override input token cost for tracking. |
| `costPerOutputToken` | number | Override output token cost for tracking. |
| `sandboxRoot` | string | Restrict file operations to this directory. |
| `toolsFiles` | string[] | JSON files defining extra tools. |
| `addDirs` | string[] | Skill directories to load. |
| `transforms` | string[] | Transforms to apply (e.g. `["middle-out"]`). |
| `extraArgs` / `args` | string[] | Extra CLI arguments passed through to orager verbatim. |

---

## Popular model IDs

| Model | ID |
|---|---|
| DeepSeek V3.2 | `deepseek/deepseek-chat-v3-2` |
| DeepSeek R1 | `deepseek/deepseek-r1` |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` |
| Claude Opus 4.6 | `anthropic/claude-opus-4-6` |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4-5` |
| GPT-4o | `openai/gpt-4o` |
| OpenAI o3 | `openai/o3` |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |

Append `:free`, `:nitro`, `:floor`, `:online`, `:thinking`, or `:extended` to any model ID for variant behaviour. Full catalogue at [openrouter.ai/models](https://openrouter.ai/models).
