# paperclip-openrouter-adapter

Connects [Paperclip](https://paperclipai.com) to [OpenRouter](https://openrouter.ai) — giving every Paperclip agent access to 300+ AI models (DeepSeek, GPT-4o, Gemini, Llama, Claude, and more) through a single API key, powered by the [`orager`](https://github.com/JayCodesX/orager) agent engine.

---

## Why we built this

Paperclip's default adapter is tied to Claude via the Anthropic API. That works well for quality, but:

- **Cost**: Claude Sonnet costs ~$3/M input tokens and ~$15/M output tokens. For agents that run dozens of heartbeats per day, this is expensive. DeepSeek V3 via OpenRouter costs ~$0.27/M input — roughly **30× cheaper** for equivalent coding tasks.
- **Model lock-in**: Different tasks benefit from different models. A quick file edit doesn't need Claude Opus. A complex architecture review might. Being locked to one provider means paying premium prices for everything.
- **Startup overhead**: The claude-local adapter spawns a new CLI process for every heartbeat. On a Mac Mini running 10 agents, that's 500–2000ms of pure startup waste per run before the model even sees the prompt.

**This adapter solves all three:**

1. **Any model, one key** — OpenRouter proxies Anthropic, OpenAI, Google, Meta, Mistral, and 100+ other providers. One `OPENROUTER_API_KEY` unlocks everything. For Claude specifically, a direct `ANTHROPIC_API_KEY` bypasses OpenRouter entirely for zero markup.
2. **Model routing** — route cheap triggers (comment_added) to DeepSeek, expensive triggers (PR review) to Claude Sonnet, architectural decisions to DeepSeek R1. Configurable per wake reason, per turn count, per cost threshold.
3. **Daemon mode** — keep orager alive between heartbeats. Node.js startup cost drops to ~0ms. Skill caches, tool result caches, and LLM prompt caches stay warm across runs.

---

## Architecture

```
Paperclip (event trigger: PR opened, comment added, manual, etc.)
    │
    │  execute(ctx)
    ▼
execute-cli.ts  (adapter entrypoint)
    │
    ├─── daemon path (fast) ──────────────────────────────────────────┐
    │    reads ~/.orager/daemon.key                                   │
    │    mints HS256 JWT { agentId, scope:"run", exp:now+5min }      │
    │    POST http://127.0.0.1:<port>/run                             │
    │    streams NDJSON response                                      │
    │    on 503: reads Retry-After, waits, retries with fresh JWT     │
    │    on persistent 503: falls through to spawn path              │
    │                                                                 │
    └─── spawn path (fallback) ───────────────────────────────────────┘
         writes config JSON to chmod-600 temp file (crypto random name)
         spawn("orager", ["--print", "-", "--config-file", path])
         writes prompt to stdin
         temp file deleted before first API call
    │
    ▼
orager process / daemon run handler
    │
    │  loop.ts  — multi-turn agent loop
    │  ┌────────────────────────────────────────────────────────────┐
    │  │  load skills from --add-dir (mtime fingerprint cache)      │
    │  │  build system prompt (base + skills + instructions file)   │
    │  │  apply Anthropic cache breakpoints (anthropic/* models)    │
    │  │  set X-Session-Id for sticky OpenRouter routing            │
    │  │                                                            │
    │  │  TURN LOOP                                                 │
    │  │    call OpenRouter API (or direct Anthropic API)           │
    │  │    stream SSE → parse text + tool calls + reasoning        │
    │  │    execute tools (up to 10 concurrent)                     │
    │  │    check cost cap / context threshold / loop detection     │
    │  │    save session to ~/.orager/sessions/<id>.json            │
    │  └────────────────────────────────────────────────────────────┘
    │
    │  emit stream-json events (one JSON object per line)
    ▼
execute-cli.ts  — event consumer
    │  parses each line via parseStdout()
    │  streams to ctx.onLog("stdout", line)
    │  captures: session_id, resolvedModel, usage, costUsd
    ▼
AdapterExecutionResult
    { exitCode, summary, sessionParams: { oragerSessionId }, usage, costUsd }
    │
    ▼
Paperclip stores sessionParams → passes back on next heartbeat → session resumes
```

### Key architectural decisions

**Why a separate `orager` process instead of an in-process library?**
Paperclip runs multiple agents concurrently. Isolating each agent in its own process gives independent memory, clean process-level timeouts, and safe crash isolation — one runaway agent can't corrupt another's state.

**Why daemon mode?**
The spawn path works but has unavoidable overhead: Node.js init (~100ms), module loading (~100ms), skill file reads (~50ms), and the first LLM cache miss (~200ms extra). The daemon eliminates all of this. Subsequent runs hit the warm process immediately.

**Why JWT auth on the daemon?**
The daemon runs on a shared machine and accepts run requests. Without auth, any process on the machine could POST to it and execute arbitrary shell commands. The JWT ensures only the adapter (which holds the signing key) can submit runs.

**Why temp config files instead of CLI args?**
The config includes API keys, prompt content, and file paths. Passing these as CLI args exposes them in `ps aux` output, shell history, and system logs. A chmod-600 temp file that is deleted before the first network call is considerably safer.

---

## Install into Paperclip

```bash
npm install -g @paperclipai/orager
export OPENROUTER_API_KEY=sk-or-...
bash /path/to/paperclip-openrouter-adapter/install.sh
```

The install script (run from the Paperclip repo root):
1. Copies `openrouter/` → `packages/adapters/openrouter/`
2. Copies `ui-adapter/` → `ui/src/adapters/openrouter/`
3. Patches `server/src/adapters/registry.ts`
4. Patches `ui/src/adapters/registry.ts`
5. Patches `cli/src/adapters/registry.ts`
6. Runs `pnpm install`

Restart Paperclip → **OpenRouter (orager)** appears in the adapter dropdown.

---

## Source layout

```
paperclip-openrouter-adapter/
├── install.sh                      One-command install (run from Paperclip root)
├── openrouter/                     Adapter package (@paperclipai/adapter-openrouter)
│   └── src/
│       ├── index.ts                Adapter identity, models list, sessionCodec
│       ├── server/
│       │   ├── index.ts            Exports execute() and testEnvironment()
│       │   ├── execute-cli.ts      Daemon fast-path + spawn fallback, full event pipeline
│       │   ├── sessions.ts         Session browser API (list, search, get) — daemon + filesystem
│       │   ├── jwt-utils.ts        mintDaemonJwt — shared JWT minting for execute-cli + sessions
│       │   └── test.ts             Environment validation (API key, orager binary, connectivity)
│       ├── ui/
│       │   ├── parse-stdout.ts     Converts orager stream-json → TranscriptEntry[]
│       │   └── build-config.ts     Config builder with adapter defaults
│       └── cli/
│           └── format-event.ts     Formats orager events for the Paperclip CLI
└── ui-adapter/
    ├── index.ts                    UIAdapterModule definition
    └── config-fields.tsx           Config form: API key, model, daemon, maxTurns, etc.
```

### What each server file does and why it exists

**`execute-cli.ts`** — The heart of the adapter. Receives Paperclip's `execute(ctx)` call and drives the entire run. It handles:
- Config assembly (merging Paperclip context + adapter config + defaults)
- Wake-reason model routing (maps Paperclip trigger type to model override)
- Daemon health check and JWT minting
- Temp config file creation (chmod 600, crypto-random name, deleted before first API call)
- Stream parsing for both daemon (NDJSON) and spawn (line-buffered stdout) paths
- Session ID extraction and propagation back to Paperclip for resumption
- Cost and usage aggregation
- Retry logic with Retry-After header support

**`sessions.ts`** — Session browser for Paperclip's UI. Exposes `listOragerSessions`, `searchOragerSessions`, and `getOragerSession`. Tries the daemon first (which may use a SQLite index for fast queries), falls back to reading `~/.orager/sessions/*.json` directly using parallel `stat()` → sort by mtime → slice to page window → read only the needed files. Built because Paperclip needs to display session history without requiring the daemon.

**`jwt-utils.ts`** — Centralised `mintDaemonJwt(signingKey, agentId)` function. Extracted from `execute-cli.ts` to avoid duplication since both the execute path and the sessions path need to make authenticated daemon requests.

**`test.ts`** — Environment validation run before the first agent execution. Checks that `OPENROUTER_API_KEY` (or per-agent `apiKey`) is set and non-empty, that the `orager` binary is on PATH (or at the configured `cliPath`), and that OpenRouter's API is reachable. Returns structured pass/fail results so Paperclip can surface configuration problems before wasting a full heartbeat.

**`parse-stdout.ts`** — Converts orager's `stream-json` event format into Paperclip's `TranscriptEntry[]`. Each orager event type (assistant text, tool call, tool result, system messages) maps to a corresponding Paperclip transcript shape. Built as a separate module so the UI and CLI can both consume it.

**`index.ts`** (server) — Thin re-export layer that satisfies Paperclip's adapter interface: `execute`, `testEnvironment`, adapter metadata (name, id, version).

---

## Configuration reference

All fields go in the agent's adapter config. Only `apiKey` is required (or set `OPENROUTER_API_KEY` in the server environment).

### Core

| Field | Type | Default | Description |
|---|---|---|---|
| `apiKey` | string | — | **Required.** OpenRouter API key. Use a `secret_ref` in production. |
| `model` | string | `deepseek/deepseek-chat-v3-0324` | Any OpenRouter model ID. |
| `models` | string[] | — | Fallback models tried in order on 429/503. |
| `promptTemplate` | string | built-in | User message sent every run. Supports `{{agent.name}}`, `{{context.wakeReason}}`, etc. |
| `bootstrapPromptTemplate` | string | — | Sent only on the first run (no prior session). |
| `maxTurns` / `maxTurnsPerRun` | number | `20` | Maximum agent turns per run. |
| `maxRetries` | number | `3` | API retries on transient errors. |
| `timeoutSec` | number | `300` | Total run timeout in seconds. `0` = unlimited. |
| `graceSec` | number | `20` | Seconds between SIGTERM and SIGKILL on timeout. |
| `cliPath` | string | `orager` | Path to orager binary if not on PATH. |
| `cwd` | string | `process.cwd()` | Working directory for the agent. |
| `siteUrl` | string | — | HTTP-Referer header for OpenRouter attribution. |
| `siteName` | string | — | X-Title header for OpenRouter attribution. |
| `env` | object | — | Extra environment variables passed to the subprocess. |
| `daemonUrl` | string | — | Override daemon URL (e.g. `http://127.0.0.1:3456`). Also read from `ORAGER_DAEMON_URL`. |
| `instructionsFilePath` | string | — | Path to a file appended to the system prompt. Must resolve within `cwd` (symlinks are resolved before validation). |
| `requiredEnvVars` | string[] | — | Env vars that must be present. Agent fails immediately with a clear error if any are missing. |
| `dryRun` | boolean | `false` | Log config + prompt preview but make no API calls. Returns a fake success. Use to verify config without spending tokens. |
| `extraArgs` / `args` | string[] | — | Extra CLI arguments passed through to orager verbatim. |

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

Reasoning is **excluded by default** — tokens cost 2–3× more. Enable explicitly when needed.

```yaml
reasoning:
  effort: medium        # xhigh | high | medium | low | minimal | none
  max_tokens: 8000      # exact reasoning token budget
  exclude: false        # set to false to enable (default: true)
```

`effort` allocates a percentage of `maxTokens`: `xhigh` ≈ 95%, `high` ≈ 80%, `medium` ≈ 50%, `low` ≈ 20%, `minimal` ≈ 10%.

### Provider routing

```yaml
provider:
  order: ["DeepSeek", "Together"]   # preferred provider slugs
  require_parameters: true          # default: true — only route to providers supporting all params
  data_collection: deny             # exclude providers that train on your data
  zdr: true                         # Zero Data Retention providers only
  only: ["DeepSeek"]                # provider allowlist
  ignore: ["Azure"]                 # provider blocklist
  quantizations: ["fp16", "bf16"]   # filter by quantization
  sort: latency                     # price | throughput | latency (default: latency)
```

**Defaults applied automatically:**
- `sort: "latency"` — minimizes TTFT for agent loops
- `require_parameters: true` — prevents silent routing to providers that ignore tool definitions

### Tool control

| Field | Type | Default | Description |
|---|---|---|---|
| `parallel_tool_calls` | boolean | `true` | Execute multiple tool calls concurrently. |
| `tool_choice` | string | — | `auto` / `none` / `required` |
| `dangerouslySkipPermissions` | boolean | `false` | Skip all tool approval prompts. |
| `useFinishTool` | boolean | `false` | Model calls a `finish` tool to signal completion. |
| `requireApproval` | boolean | `false` | Require human approval before any tool runs. |
| `requireApprovalFor` | string | — | Comma-separated list of tools requiring approval. |
| `sandboxRoot` | string | — | Restrict file operations to this directory. |
| `toolsFiles` | string[] | — | JSON files defining extra tools. |
| `addDirs` | string[] | — | Additional skill directories (bundled Paperclip skills always included). |

### Context management

| Field | Type | Default | Description |
|---|---|---|---|
| `summarizeAt` | number | — | Fraction of context window (0–1) at which session history is compacted. 500-message hard cap always applies. |
| `summarizeModel` | string | primary model | Model used for summarization. A cheap fast model works well (e.g. `deepseek/deepseek-chat-v3-0324`). |

### Agent routing

| Field | Type | Description |
|---|---|---|
| `wakeReasonModels` | object | Map Paperclip wake reasons to model overrides. Keys are wake reason strings, values are model IDs. Example: `{ "manual": "anthropic/claude-opus-4-6", "comment_added": "deepseek/deepseek-chat-v3-0324" }` |
| `turnModelRules` | object[] | Per-turn model routing rules. First matching rule wins. |

#### Turn model routing rules

| Field | Type | Description |
|---|---|---|
| `model` | string | **Required.** Model to switch to. |
| `afterTurn` | number | Match when turn ≥ this value (0-indexed). |
| `costAbove` | number | Match when cumulative cost > this USD value. |
| `tokensAbove` | number | Match when cumulative prompt tokens > this count. |
| `once` | boolean | Apply for one turn only. Default: false (sticky). |

**Example — start cheap, escalate to Claude after 5 turns:**
```yaml
turnModelRules:
  - afterTurn: 5
    model: anthropic/claude-sonnet-4-6
```

**Example — upgrade once when cost crosses $0.01:**
```yaml
turnModelRules:
  - costAbove: 0.01
    model: deepseek/deepseek-r1
    once: true
```

### Cost & visibility

| Field | Type | Description |
|---|---|---|
| `maxCostUsd` | number | **Hard stop.** Abort the run if accumulated cost exceeds this amount. |
| `maxCostUsdSoft` | number | **Soft warning.** Log a warning when cost exceeds this amount. Does not stop the run. |
| `costPerInputToken` | number | Input token cost override (uses OpenRouter pricing otherwise). |
| `costPerOutputToken` | number | Output token cost override. |

### OpenRouter features

| Field | Type | Description |
|---|---|---|
| `preset` | string | OpenRouter named preset slug (server-side routing/model config) |
| `transforms` | string[] | Context transforms, e.g. `["middle-out"]` for automatic compression |

---

## Daemon mode

The daemon keeps orager alive between heartbeats, eliminating startup overhead and keeping caches warm.

### Start the daemon

```bash
OPENROUTER_API_KEY=sk-or-... orager --serve --port 3456
```

### Tell the adapter to use it

```bash
export ORAGER_DAEMON_URL=http://127.0.0.1:3456
```

Or in the agent config:

```yaml
daemonUrl: "http://127.0.0.1:3456"
```

### Auto-start

```bash
export ORAGER_DAEMON_URL=http://127.0.0.1:3456
export ORAGER_DAEMON_AUTOSTART=true
```

The adapter polls `/health` for up to 5 seconds before falling back to spawn mode.

### What the adapter does on each run

1. Reads `~/.orager/daemon.key` to mint a short-lived HS256 JWT (5-min TTL)
2. POSTs the run request to `http://127.0.0.1:<port>/run` with `Authorization: Bearer <jwt>`
3. Streams NDJSON events back — same parsing pipeline as the spawn path
4. On 503 (saturated): reads `Retry-After`, waits (max 30s), retries with a fresh JWT
5. Falls back to spawning orager if the daemon is unreachable or still saturated

### Metrics

```bash
curl http://127.0.0.1:3456/metrics
```

```json
{
  "activeRuns": 1,
  "maxConcurrent": 3,
  "completedRuns": 47,
  "errorRuns": 2,
  "draining": false,
  "uptimeMs": 183200,
  "model": "deepseek/deepseek-chat-v3-0324"
}
```

### macOS launchd (auto-start on login)

```xml
<!-- ~/Library/LaunchAgents/com.orager.daemon.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.orager.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/orager</string>
    <string>--serve</string>
    <string>--port</string><string>3456</string>
    <string>--idle-timeout</string><string>120m</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENROUTER_API_KEY</key><string>sk-or-...</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/orager-daemon.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.orager.daemon.plist
```

---

## Performance defaults

Applied automatically — no config needed:

| Optimization | Default | Notes |
|---|---|---|
| Parallel tool calls | `true` | Multiple tools execute concurrently per turn |
| Reasoning excluded | `true` | Saves 2–3× token cost; enable with `reasoning.exclude: false` |
| Provider sort | `latency` | Minimizes TTFT; overridden by explicit `provider.order` |
| `require_parameters` | `true` | Prevents silent routing to providers that ignore tool definitions |
| Config via temp file | always | chmod-600, crypto-random name, deleted before first API call |
| Anthropic cache breakpoints | auto | Applied for `anthropic/*` models |
| X-Session-Id sticky routing | auto | OpenRouter routes same session to same provider endpoint |
| Skills cache | auto | Mtime-fingerprinted, 5-min max TTL |
| Tool result cache | auto | Read-only tools, 30s TTL, per invocation |
| Adaptive timeout | auto | Reasoning models: 600s; flash/mini/haiku: 120s; default: 300s |
| Cache hit ratio | auto | `cacheHitRatio` (0–1) in every run result |

---

## Multimodal inputs

If Paperclip provides image attachments (screenshots, uploads), the adapter automatically builds a multimodal first message combining text and image content blocks. Works with any vision-capable model:

| Model | ID |
|---|---|
| GPT-4o | `openai/gpt-4o` |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |
| Llama 3.2 Vision | `meta-llama/llama-3.2-90b-vision-instruct` |

---

## Structured logs

```bash
export ORAGER_LOG_FILE=/var/log/orager/adapter.log
```

```json
{"level":"info","ts":1703123456789,"event":"run_start","agentId":"agent-1","model":"deepseek/deepseek-chat-v3-0324"}
{"level":"info","ts":1703123469012,"event":"run_complete","durationMs":12223,"inputTokens":4200,"cacheHitRatio":0.71,"costUsd":0.000087}
```

| Event | Level | When |
|---|---|---|
| `run_start` | info | Run is beginning |
| `run_complete` | info | Run finished (includes tokens, cost, turn count) |
| `dry_run` | info | Dry-run mode — no API calls made |
| `env_var_missing` | error | Required env vars not present |
| `soft_cost_limit` | warn | Run cost exceeded `maxCostUsdSoft` |
| `daemon_retry` | warn | Daemon returned 503, retrying |
| `daemon_fallback` | warn | Daemon unreachable, falling back to spawn |

Compatible with Datadog, CloudWatch, Loki, and any JSON log aggregator.

---

## Cost comparison

| | Claude Sonnet (claude-local) | DeepSeek V3 (this adapter) |
|---|---|---|
| Input | ~$3.00 / M tokens | ~$0.27 / M tokens |
| Output | ~$15.00 / M tokens | ~$1.10 / M tokens |
| Cached input | ~$0.30 / M tokens | ~$0.07 / M tokens |
| **Typical heartbeat cost** | ~$0.003 | ~$0.00005–0.0001 |
| **Savings** | baseline | **~30×** |

---

## Popular model IDs

| Model | ID |
|---|---|
| DeepSeek V3 | `deepseek/deepseek-chat-v3-0324` |
| DeepSeek R1 | `deepseek/deepseek-r1` |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` |
| Claude Opus 4.6 | `anthropic/claude-opus-4-6` |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4-5` |
| GPT-4o | `openai/gpt-4o` |
| OpenAI o3 | `openai/o3` |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |

Append `:free`, `:nitro`, `:floor`, `:online`, `:thinking`, or `:extended` to any model ID. Full catalogue at [openrouter.ai/models](https://openrouter.ai/models).

---

## Development

```bash
cd openrouter
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
```
