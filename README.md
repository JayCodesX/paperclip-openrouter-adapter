# paperclip-openrouter-adapter

Connects [Paperclip](https://paperclipai.com) agents to [OpenRouter](https://openrouter.ai) — giving every agent access to 300+ AI models through a single API key, powered by the [`orager`](https://github.com/JayCodesX/orager) agent engine.

## Problem

Paperclip's default adapter is locked to Claude via the Anthropic API. This creates three issues:

1. **Cost** — Claude Sonnet costs ~$3/M input tokens. Agents running dozens of heartbeats per day burn through budget fast. DeepSeek V3 via OpenRouter costs ~$0.27/M input — roughly **30x cheaper** for equivalent coding tasks.
2. **Model lock-in** — different tasks benefit from different models. A quick file edit doesn't need Claude Opus. A complex architecture review might. One provider means paying premium prices for everything.
3. **Startup overhead** — the claude-local adapter spawns a new CLI process for every heartbeat. On a Mac Mini running 10 agents, that's 500-2000ms of pure startup waste per run.

## Solution

This adapter replaces Paperclip's default claude-local adapter with one that routes through OpenRouter (or directly to Anthropic), using orager as the execution engine. It solves all three problems:

- **Any model, one key** — OpenRouter proxies Anthropic, OpenAI, Google, Meta, Mistral, and 100+ other providers. Direct `ANTHROPIC_API_KEY` support for zero-markup Claude access.
- **Smart model routing** — route cheap triggers to DeepSeek, expensive triggers to Claude, architectural decisions to reasoning models. Configurable per wake reason, per turn count, per cost threshold.
- **Daemon mode** — keeps orager alive between heartbeats. Node.js startup cost drops to ~0ms. All caches stay warm.

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│                     Paperclip Platform                          │
│                                                                 │
│  Event trigger: PR opened, comment added, manual run, etc.      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           │  execute(ctx)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    execute-cli.ts                                │
│                  (adapter entrypoint)                            │
│                                                                 │
│  1. Build config (merge Paperclip ctx + adapter settings)       │
│  2. Apply wake-reason model routing                             │
│  3. Construct API key pool                                      │
│                                                                 │
│  ┌──────────────────┐    ┌──────────────────────────────────┐   │
│  │  Daemon path     │    │  Spawn path (fallback)           │   │
│  │  (fast)          │    │                                  │   │
│  │                  │    │  Write config to chmod-600       │   │
│  │  Read daemon.key │    │  temp file (crypto random name)  │   │
│  │  Mint HS256 JWT  │    │                                  │   │
│  │  POST /run       │    │  spawn("orager",                │   │
│  │  Stream NDJSON   │    │    ["--config-file", path])      │   │
│  │                  │    │                                  │   │
│  │  On 503: retry   │    │  Pipe prompt to stdin            │   │
│  │  with Retry-After│    │  Temp file deleted before        │   │
│  │                  │    │  first API call                  │   │
│  └────────┬─────────┘    └──────────────┬───────────────────┘   │
│           │                             │                       │
│           └──────────────┬──────────────┘                       │
│                          │                                      │
│  4. Parse NDJSON events (text, tool calls, results, warnings)   │
│  5. Extract session_id, usage, cost                             │
│  6. Return AdapterExecutionResult                               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Paperclip Platform                          │
│                                                                 │
│  Stores sessionParams.oragerSessionId                           │
│  Passes back on next heartbeat → session resumes                │
└─────────────────────────────────────────────────────────────────┘
```

## Features

### Adapter core (`execute-cli.ts`)
The primary entrypoint. Receives Paperclip's `execute(ctx)` call and drives the entire run:
- **Dual execution paths** — tries the daemon first (zero startup cost), falls back to spawning a fresh orager process
- **Wake-reason model routing** — maps Paperclip trigger types (PR opened, comment added, manual) to different model overrides
- **API key pool** — collects `apiKey` + `apiKeys[]` into an ordered pool for mid-run key rotation on 429
- **Secure config transport** — writes config (including API keys) to a chmod-600 temp file with a crypto-random name, deleted before the first API call
- **Session continuity** — extracts `oragerSessionId` from run results and passes it back to Paperclip for resumption
- **Resource limits** — configurable memory and CPU limits via `ulimit` wrapping, response body size cap (default 50MB)

### Session browser (`sessions.ts`)
Exposes `listOragerSessions`, `searchOragerSessions`, and `getOragerSession` for Paperclip's UI. Tries the daemon first (which may use SQLite for fast queries), falls back to reading session JSON files directly with optimized parallel I/O.

### Environment validation (`test.ts`)
Pre-flight checks before the first agent execution: verifies API key presence, orager binary availability, and OpenRouter API reachability. Returns structured pass/fail results so Paperclip surfaces configuration problems before wasting a heartbeat.

### Event parsing (`parse-stdout.ts`)
Converts orager's `stream-json` event format into Paperclip's `TranscriptEntry[]`. Each orager event type (assistant text, tool call, tool result, system messages) maps to a corresponding Paperclip transcript shape.

### UI config (`ui-adapter/`)
Config form for Paperclip's UI: API key, model selection, daemon URL, max turns, sampling parameters, provider routing, reasoning settings, and tool controls.

### Bundled skills (`openrouter/skills/`, `skills/`)
Agent skill definitions (SKILL.md files) that extend orager's capabilities within the Paperclip ecosystem. Includes Paperclip-specific skills for agent creation, issue management, and memory management.

### Model routing

**Per wake reason:**
```yaml
wakeReasonModels:
  manual: anthropic/claude-opus-4-6
  comment_added: deepseek/deepseek-chat-v3-0324
  pr_opened: anthropic/claude-sonnet-4-6
```

**Per turn count / cost:**
```yaml
turnModelRules:
  - afterTurn: 5
    model: anthropic/claude-sonnet-4-6
  - costAbove: 0.01
    model: deepseek/deepseek-r1
    once: true
```

### Cost comparison

| | Claude Sonnet (claude-local) | DeepSeek V3 (this adapter) |
|---|---|---|
| Input | ~$3.00 / M tokens | ~$0.27 / M tokens |
| Output | ~$15.00 / M tokens | ~$1.10 / M tokens |
| Cached input | ~$0.30 / M tokens | ~$0.07 / M tokens |
| **Typical heartbeat** | ~$0.003 | ~$0.00005-0.0001 |
| **Savings** | baseline | **~30x** |

### Structured logging
JSON logs compatible with Datadog, CloudWatch, Loki. Events: `run_start`, `run_complete`, `daemon_retry`, `daemon_fallback`, `session_lost`, `soft_cost_limit`, and more. Set `ORAGER_LOG_FILE` to enable.

## Install

```bash
npm install -g @paperclipai/orager
export OPENROUTER_API_KEY=sk-or-...
bash /path/to/paperclip-openrouter-adapter/install.sh
```

The install script copies the adapter into Paperclip's package structure, patches the adapter registries (server, UI, CLI), and runs `pnpm install`.

## Development

```bash
cd openrouter
npm install
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run test        # vitest run
```
