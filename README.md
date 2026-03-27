# openrouter-local — Paperclip adapter

Adds **OpenRouter-backed agent loops** to [Paperclip](https://paperclipai.com) using the [`orager`](https://github.com/JayCodesX/orager) CLI — works with any OpenRouter model (DeepSeek, GPT-4o, Gemini, Anthropic, Llama, and 300+ more).

---

## How it works

```
Paperclip heartbeat
    │  execute(ctx)
    ▼
execute-cli.ts
    │  checks ORAGER_DAEMON_URL / config.daemonUrl
    │  ─── daemon path ──────────────────────────────────────
    │  reads ~/.orager/daemon.key
    │  mints JWT { agentId, scope: "run", exp: now+5min }
    │  POST /run → daemon (NDJSON streaming response)
    │  ─── spawn path (fallback) ────────────────────────────
    │  writes config to chmod-600 temp file
    │  spawn("orager", ["--print", "-", "--config-file", path])
    │  write prompt → stdin
    ▼
orager process (or daemon run handler)
    │  loads skills from --add-dir paths (mtime-cached)
    │  applies Anthropic cache breakpoints (anthropic/* models)
    │  sets X-Session-Id for sticky OpenRouter routing
    │  calls OpenRouter API (multi-turn tool-calling loop)
    │  executes tools: bash, read_file, write_file, str_replace, list_dir, web_fetch
    │  emits stream-json events on stdout / NDJSON stream
    ▼
execute-cli.ts reads events
    │  streams each line to ctx.onLog("stdout", line)
    │  captures session_id, resolvedModel, usage, cost
    ▼
AdapterExecutionResult
    { exitCode, summary, sessionParams: { oragerSessionId }, usage, costUsd }
```

Sessions are resumed automatically across heartbeats — Paperclip stores the orager session ID in `sessionParams` and passes it back on the next run.

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
├── install.sh                one-command install (run from Paperclip root)
├── docs/
│   └── PERFORMANCE_PLAN.md   full performance & security plan (all phases)
│
├── openrouter/               adapter package (@paperclipai/adapter-openrouter)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              adapter identity, models, sessionCodec
│       ├── server/
│       │   ├── index.ts          exports execute (= executeAgentLoop), testEnvironment
│       │   ├── execute-cli.ts    daemon fast-path + spawn fallback, event streaming
│       │   └── test.ts           env validation: API key, connectivity, orager binary
│       ├── ui/
│       │   ├── index.ts
│       │   ├── parse-stdout.ts   converts orager stream-json → TranscriptEntry[]
│       │   └── build-config.ts   config builder with agent-loop defaults
│       └── cli/
│           ├── index.ts
│           └── format-event.ts   formats orager events for the Paperclip CLI
│
└── ui-adapter/               React UI module (copied to ui/src/adapters/openrouter/)
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
| `model` | string | `deepseek/deepseek-chat-v3-0324` | Any OpenRouter model ID. |
| `models` | string[] | — | Fallback models tried in order on 429/503. |
| `promptTemplate` | string | built-in | User message sent every run. Supports `{{agent.name}}`, `{{context.wakeReason}}`, etc. |
| `bootstrapPromptTemplate` | string | — | Sent only on the first run (no prior session). Use for stable setup instructions. |
| `maxTurns` / `maxTurnsPerRun` | number | `20` | Maximum agent turns per run. |
| `maxRetries` | number | `3` | API retries on transient errors. |
| `timeoutSec` | number | `300` | Total run timeout in seconds. `0` = unlimited. |
| `graceSec` | number | `20` | Seconds between SIGTERM and SIGKILL on timeout. |
| `cliPath` | string | `orager` | Path to the orager binary if not on PATH. |
| `cwd` | string | `process.cwd()` | Working directory for the spawned process. |
| `siteUrl` | string | — | HTTP-Referer header for OpenRouter attribution. |
| `siteName` | string | — | X-Title header for OpenRouter attribution. |
| `env` | object | — | Extra environment variables passed to the subprocess. |
| `daemonUrl` | string | — | Override daemon URL (e.g. `http://127.0.0.1:3456`). Also read from `ORAGER_DAEMON_URL` env var. |

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

Reasoning is **excluded by default** — reasoning tokens cost 2–3× more and are rarely needed for routine agent tasks. Enable explicitly when needed:

```yaml
reasoning:
  effort: medium        # xhigh | high | medium | low | minimal | none
  max_tokens: 8000      # exact reasoning token budget (Anthropic, Gemini, Alibaba)
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
  sort: latency                     # default: latency — price | throughput | latency
```

**Defaults applied by the adapter:**
- `sort: "latency"` — minimizes time-to-first-token for agent loops (overridden if `order` is set)
- `require_parameters: true` — prevents silent fallbacks to providers that ignore tool definitions

### Tool control

| Field | Type | Default | Description |
|---|---|---|---|
| `parallel_tool_calls` | boolean | `true` | Execute multiple tool calls concurrently. Set `false` for strictly sequential workflows. |
| `tool_choice` | string | — | `auto` / `none` / `required` |

### OpenRouter features

| Field | Type | Description |
|---|---|---|
| `preset` | string | OpenRouter named preset slug (server-side routing/model config; update routing without redeploying) |
| `transforms` | string[] | Context transforms, e.g. `["middle-out"]` for automatic conversation compression |

### Context management

| Field | Type | Default | Description |
|---|---|---|---|
| `summarizeAt` | number | — | Fraction of context window (0–1) at which session history is compacted, e.g. `0.8`. Leave unset to disable. 500-message hard cap always applies. |
| `summarizeModel` | string | primary model | Model used for summarization. A cheap fast model works well here (e.g. `deepseek/deepseek-chat-v3-0324`). |

### Agent routing

| Field | Type | Description |
|---|---|---|
| `wakeReasonModels` | object | Map Paperclip wake reasons to model overrides. Keys are wake reason strings (e.g. `"comment_added"`, `"manual"`), values are model IDs. Useful for routing expensive triggers to smarter models. |
| `turnModelRules` | object[] | Per-turn model routing rules evaluated before each API call. First matching rule wins. Lower priority than `onTurnStart`. See below. |

#### Turn model routing rules

Each rule in `turnModelRules` has:

| Field | Type | Description |
|---|---|---|
| `model` | string | **Required.** Model to switch to when this rule matches. |
| `afterTurn` | number | Match when turn number ≥ this value (0-indexed). |
| `costAbove` | number | Match when cumulative cost > this USD value. |
| `tokensAbove` | number | Match when cumulative prompt tokens > this count. |
| `once` | boolean | Apply for one turn only, then stop. Default: false (sticky). |

Rules are evaluated in order; the first match wins. `onTurnStart` callback overrides always take priority over rules.

**Example — escalate to Claude after 5 cheap turns:**
```yaml
turnModelRules:
  - afterTurn: 5
    model: anthropic/claude-sonnet-4-6
```

**Example — upgrade once when cost crosses $0.01, then revert:**
```yaml
turnModelRules:
  - costAbove: 0.01
    model: deepseek/deepseek-r1
    once: true
```

### Cost & visibility

| Field | Type | Description |
|---|---|---|
| `maxCostUsd` | number | **Hard stop.** Abort the run if accumulated cost exceeds this USD value. |
| `maxCostUsdSoft` | number | **Soft warning.** Log a warning when a single run exceeds this amount. Does not stop the run. |
| `costPerInputToken` | number | Input token cost override for tracking (uses OpenRouter pricing otherwise). |
| `costPerOutputToken` | number | Output token cost override for tracking. |

### Agent loop options

| Field | Type | Description |
|---|---|---|
| `dangerouslySkipPermissions` | boolean | Pass `--dangerously-skip-permissions`. Skips all tool approval prompts. |
| `useFinishTool` | boolean | Model calls a `finish` tool to signal completion. |
| `requireApproval` | boolean | Require human approval before any tool runs. |
| `requireApprovalFor` | string | Comma-separated list of tools that require approval. |
| `sandboxRoot` | string | Restrict file operations to this directory. |
| `toolsFiles` | string[] | JSON files defining extra tools. |
| `addDirs` | string[] | Additional skill directories to load (the bundled Paperclip skills dir is always included). |
| `instructionsFilePath` | string | Path to a file appended to the system prompt (agent-specific instructions). |
| `requiredEnvVars` | string[] | Environment variables that must be present on the server. Agent fails immediately with a clear error if any are missing. |
| `dryRun` | boolean | Log config + prompt preview but make no API calls. Returns a fake success. Use to verify config changes without spending tokens. |
| `extraArgs` / `args` | string[] | Extra CLI arguments passed through to orager verbatim. |

---

## Daemon mode (no subprocess overhead)

The daemon keeps Node.js running between heartbeats, eliminating 50–200ms startup time and keeping all in-process caches warm.

### Start the daemon

```bash
# On Mac Mini / your server (runs persistently, auto-exits after 30min idle)
OPENROUTER_API_KEY=sk-or-... orager --serve --port 3456

# Or with systemd / launchd for auto-restart on reboot (see examples below)
```

### Tell the adapter to use it

Set the environment variable on the Paperclip server:

```bash
export ORAGER_DAEMON_URL=http://127.0.0.1:3456
```

Or set `daemonUrl` in the agent's adapter config:

```yaml
daemonUrl: "http://127.0.0.1:3456"
```

### Auto-start

Set `ORAGER_DAEMON_AUTOSTART=true` on the Paperclip server and the adapter will spawn the daemon automatically if `ORAGER_DAEMON_URL` is configured but the daemon is not running. The adapter polls `/health` for up to 5 seconds before falling back to spawn mode.

```bash
export ORAGER_DAEMON_URL=http://127.0.0.1:3456
export ORAGER_DAEMON_AUTOSTART=true
```

### What the adapter does

1. Reads `~/.orager/daemon.key` to mint a short-lived HS256 JWT (5-min TTL)
2. POSTs the run request to `http://127.0.0.1:3456/run` with `Authorization: Bearer <jwt>`
3. Streams NDJSON events back — same parsing as the spawn path
4. On 503 (saturated): reads `Retry-After`, waits (max 30s), retries with a fresh JWT
5. Falls back to spawning orager if the daemon is unreachable or still saturated after retry

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
  "model": "deepseek/deepseek-chat-v3-0324",
  "usedModels": ["deepseek/deepseek-chat-v3-0324", "anthropic/claude-haiku-4-5"]
}
```

### macOS launchd example

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

## Multimodal inputs (images)

If Paperclip provides image attachments in the execution context (e.g. screenshots or uploaded images on a task/comment), the adapter automatically builds a multimodal first message combining the text prompt and image content blocks.

Works with any vision-capable model on OpenRouter:

| Model | ID |
|---|---|
| GPT-4o | `openai/gpt-4o` |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4-6` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |
| Llama 3.2 Vision | `meta-llama/llama-3.2-90b-vision-instruct` |

No config required — image routing happens automatically when attachments are present. To ensure a vision-capable model is used, set `model` to a vision model or use `wakeReasonModels` to route image-heavy triggers to one.

---

## Structured logs

Set `ORAGER_LOG_FILE=/path/to/adapter.log` on the Paperclip server to write structured JSON log lines alongside normal output. Human-readable logs are unchanged.

```bash
export ORAGER_LOG_FILE=/var/log/orager/adapter.log
```

Each line is a JSON object:

```json
{"level":"info","ts":1703123456789,"event":"run_start","agentId":"agent-1","runId":"run-42","model":"deepseek/deepseek-chat-v3-0324"}
{"level":"info","ts":1703123469012,"event":"run_complete","agentId":"agent-1","runId":"run-42","durationMs":12223,"inputTokens":4200,"outputTokens":340,"cacheHitRatio":0.71,"costUsd":0.000087,"turnCount":3,"subtype":"success"}
```

**Emitted events:**

| Event | Level | Description |
|---|---|---|
| `run_start` | info | Run is beginning (after dry-run/env checks pass) |
| `run_complete` | info | Run finished (includes tokens, cost, turn count) |
| `dry_run` | info | Dry-run mode — no API calls made |
| `env_var_missing` | error | Required env vars not present |
| `soft_cost_limit` | warn | Run cost exceeded `maxCostUsdSoft` |
| `daemon_retry` | warn | Daemon returned 503, retrying after `Retry-After` |
| `daemon_fallback` | warn | Daemon unavailable, falling back to spawn |

Compatible with Datadog, CloudWatch, Loki, and any JSON log aggregator.

---

## Performance defaults

The adapter applies these optimizations automatically — no config needed:

| Optimization | Default | Notes |
|---|---|---|
| Parallel tool calls | `true` | Multiple tools execute concurrently per turn |
| Reasoning excluded | `true` | Saves 2–3× token cost; enable with `reasoning.exclude: false` |
| Provider sort | `latency` | Minimizes TTFT; overridden by explicit `provider.order` |
| `require_parameters` | `true` | Prevents silent routing to providers that ignore tool defs |
| Config via temp file | always | chmod-600 file, deleted before first API call |
| Anthropic cache breakpoints | auto | Applied for `anthropic/*` models |
| X-Session-Id sticky routing | auto | OpenRouter routes same session to same endpoint |
| Skills cache | auto | Mtime-fingerprinted, 5-min TTL |
| Tool result cache | auto | Read-only tools, 30s TTL, per invocation |
| Session summarization | opt-in | Set `summarizeAt` (e.g. `0.8`); 500-message hard cap always applies |
| Adaptive timeout | auto | Reasoning/thinking models: 600s; flash/mini/haiku: 120s; default: 300s |
| Cache hit ratio | auto | `cacheHitRatio` (0–1) included in every run result for observability |

---

## Model chaining with the orager MCP server

Because OpenRouter proxies all major models under one API key, you can chain models within a single Paperclip task — for example, use a cheap fast model for implementation and a smarter model for code review.

```
Paperclip task
    │
    ▼
orager → DeepSeek V3 (implementation)
    │  edits files, runs tests, commits
    │
    │  calls run_agent MCP tool
    ▼
orager → Claude Sonnet via OpenRouter (review)
    │  runs git diff, checks correctness
    ▼
post-comment → Paperclip issue
```

All models go through the same OpenRouter API key — no separate Anthropic key needed.

### Model chaining convention

| Step | Purpose | Suggested model |
|---|---|---|
| Implementation | Write code, edit files, run tests | `deepseek/deepseek-chat-v3-0324` |
| Review | Audit diff, check correctness | `anthropic/claude-sonnet-4-6` |
| Deep reasoning | Complex architecture decisions | `deepseek/deepseek-r1` |

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

Append `:free`, `:nitro`, `:floor`, `:online`, `:thinking`, or `:extended` to any model ID for variant behaviour. Full catalogue at [openrouter.ai/models](https://openrouter.ai/models).

---

## Cost comparison

| | Claude Sonnet (claude-local) | DeepSeek V3 (this adapter) |
|---|---|---|
| Input | ~$3.00 / M tokens | ~$0.27 / M tokens |
| Output | ~$15.00 / M tokens | ~$1.10 / M tokens |
| Cached input | ~$0.30 / M tokens | ~$0.07 / M tokens |
| **Typical turn cost** | ~$0.003 | ~$0.00005–0.0001 |
| **Savings** | baseline | **~30×** |

With prompt caching active on long-running sessions, effective input costs drop further.

---

## Future enhancements

- **Health check in test.ts** — verify daemon is alive when `daemonUrl` is configured, surface as a test environment check
- **Workspace isolation for daemon** — ensure daemon-mode runs get isolated `cwd` per request, same as spawn mode
- **Structured output support** — first-class `response_format: json_schema` field in adapter config with response-healing plugin enabled automatically
- **OpenRouter plugin config** — expose `plugins` array in adapter config for caller-controlled plugin selection beyond response-healing
- **Per-turn model routing** — dynamically switch model mid-session based on turn content (e.g. upgrade to reasoning model for architecture decisions)
- **Approval webhook** — instead of TTY prompts, POST to a configurable URL for async human approval (enables headless/serverless approval flows)
- **Preset management** — document how to create and reference OpenRouter presets; add link to the OpenRouter preset dashboard
- **Cost anomaly detection** — warn when a run cost is a significant outlier vs. a rolling average for that agent
- **API key rotation** — support multiple API keys with automatic failover if one is exhausted or rate-limited
- **OpenTelemetry spans** — emit per-turn and per-tool spans for tracing integrations
- **Structured adapter logs** — structured JSON logs from execute-cli.ts for log aggregation (Datadog, CloudWatch, etc.)
- **Session browser** — Paperclip UI page to view, resume, and rollback orager sessions across all agents
- **Progressive streaming to Paperclip** — stream partial results back to Paperclip during long runs instead of only on completion
