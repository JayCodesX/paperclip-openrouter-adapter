import { asString, asNumber, asBoolean, parseObject, } from "@paperclipai/adapter-utils/server-utils";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
// ── Local utility shims (mirrors adapter-utils functions not yet exported) ───
async function ensureAbsoluteDirectory(dir, opts = {}) {
    if (!path.isAbsolute(dir)) {
        throw new Error(`Directory must be an absolute path: ${dir}`);
    }
    try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory())
            throw new Error(`Path is not a directory: ${dir}`);
    }
    catch (err) {
        if (err.code === "ENOENT" && opts.createIfMissing) {
            await fs.mkdir(dir, { recursive: true });
        }
        else {
            throw err;
        }
    }
}
async function ensureCommandResolvable(command, cwd, env) {
    if (command.includes("/") || command.includes("\\")) {
        try {
            await fs.access(command, fsConstants.X_OK);
            return;
        }
        catch {
            throw new Error(`Command not executable: ${command}`);
        }
    }
    const pathDirs = (env.PATH ?? process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean);
    for (const dir of pathDirs) {
        try {
            await fs.access(path.join(dir, command), fsConstants.X_OK);
            return;
        }
        catch { /* next */ }
    }
    throw new Error(`Command "${command}" not found in PATH (cwd: ${cwd}).`);
}
function ensurePathInEnv(env) {
    if (env.PATH)
        return env;
    return { ...env, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
}
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
function summarizeStatus(checks) {
    if (checks.some((c) => c.level === "error"))
        return "fail";
    if (checks.some((c) => c.level === "warn"))
        return "warn";
    return "pass";
}
function resolveApiKey(config) {
    // Support apiKeys[] array (item 6 — API key rotation); first entry is the active key
    if (Array.isArray(config.apiKeys)) {
        const first = config.apiKeys.find((k) => typeof k === "string" && k.trim().length > 0);
        if (first)
            return first;
    }
    const fromConfig = asString(config.apiKey, "");
    if (fromConfig)
        return fromConfig;
    return process.env.OPENROUTER_API_KEY ?? "";
}
function firstNonEmptyLine(text) {
    return (text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "");
}
/** Run a short hello probe against the orager CLI, returning stdout + stderr. */
async function runOragerProbe(cliPath, cwd, env, timeoutMs = 45_000) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(cliPath, ["--print", "-", "--output-format", "stream-json", "--verbose"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        }
        catch {
            resolve({ stdout: "", stderr: "Failed to spawn orager", exitCode: 1, timedOut: false });
            return;
        }
        let stdoutBuf = "";
        let stderrBuf = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill("SIGTERM");
            // Force-kill after 3s grace if SIGTERM is ignored
            setTimeout(() => { try {
                proc.kill("SIGKILL");
            }
            catch { /* already dead */ } }, 3_000);
        }, timeoutMs);
        proc.stdin?.write("Respond with hello.", "utf8");
        proc.stdin?.end();
        proc.stdout?.on("data", (c) => { stdoutBuf += c.toString("utf8"); });
        proc.stderr?.on("data", (c) => { stderrBuf += c.toString("utf8"); });
        proc.on("close", (code) => {
            clearTimeout(timer);
            resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: code, timedOut });
        });
        proc.on("error", () => {
            clearTimeout(timer);
            resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: 1, timedOut: false });
        });
    });
}
function parseOragerProbeResult(stdout) {
    let resultText = "";
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        try {
            const event = JSON.parse(line);
            if (event.type === "result" && typeof event.result === "string") {
                resultText = event.result.trim();
            }
        }
        catch {
            // non-JSON line
        }
    }
    return { resultText };
}
export async function testEnvironment(ctx) {
    const checks = [];
    const config = parseObject(ctx.config);
    // ── OpenRouter API checks ─────────────────────────────────────────────────
    const baseUrl = asString(config.baseUrl, DEFAULT_BASE_URL).replace(/\/$/, "");
    const modelsUrl = `${baseUrl}/models`;
    const apiKey = resolveApiKey(config);
    if (!apiKey) {
        checks.push({
            code: "openrouter_api_key_missing",
            level: "error",
            message: "OpenRouter API key is not configured.",
            hint: "Set apiKey in the adapter config or set OPENROUTER_API_KEY in the server environment.",
        });
    }
    else {
        checks.push({
            code: "openrouter_api_key_present",
            level: "info",
            message: "OpenRouter API key is configured.",
        });
        const model = asString(config.model, "deepseek/deepseek-chat-v3-0324");
        checks.push({
            code: "openrouter_model_configured",
            level: "info",
            message: `Model: ${model}`,
        });
        const timeoutSec = asNumber(config.timeoutSec, 300);
        if (timeoutSec > 0 && timeoutSec < 10) {
            checks.push({
                code: "openrouter_timeout_very_low",
                level: "warn",
                message: `Timeout of ${timeoutSec}s may be too short for an agent loop.`,
                hint: "Consider setting timeoutSec to at least 60.",
            });
        }
        // Probe the OpenRouter /models endpoint to verify connectivity and key validity
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10_000);
            let response;
            try {
                response = await fetch(modelsUrl, {
                    headers: { Authorization: `Bearer ${apiKey}` },
                    signal: controller.signal,
                });
            }
            finally {
                clearTimeout(timer);
            }
            if (response.status === 401) {
                checks.push({
                    code: "openrouter_api_key_invalid",
                    level: "error",
                    message: "OpenRouter API key is invalid (401 Unauthorized).",
                    hint: "Verify the API key at https://openrouter.ai/settings/keys",
                });
            }
            else if (response.ok) {
                checks.push({
                    code: "openrouter_connectivity_ok",
                    level: "info",
                    message: "Successfully reached the OpenRouter API.",
                });
            }
            else {
                checks.push({
                    code: "openrouter_connectivity_warn",
                    level: "warn",
                    message: `OpenRouter /models returned HTTP ${response.status}.`,
                    hint: "Check https://status.openrouter.ai for service status.",
                });
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            checks.push({
                code: "openrouter_connectivity_failed",
                level: "error",
                message: "Could not reach the OpenRouter API.",
                detail: message.slice(0, 240),
                hint: "Verify outbound HTTPS to api.openrouter.ai is allowed from this server.",
            });
        }
    }
    // ── Orager CLI checks (only when executeAgentLoop will be used) ───────────
    const cliPath = asString(config.cliPath, "orager");
    const cwd = asString(config.cwd, process.cwd());
    const envConfig = parseObject(config.env);
    const extraEnv = {};
    for (const [key, value] of Object.entries(envConfig)) {
        if (typeof value === "string")
            extraEnv[key] = value;
    }
    const runtimeEnv = ensurePathInEnv({
        ...process.env,
        ...extraEnv,
        ...(apiKey ? { OPENROUTER_API_KEY: apiKey, ORAGER_API_KEY: apiKey } : {}),
    });
    // Validate cwd
    try {
        await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
        checks.push({
            code: "orager_cwd_valid",
            level: "info",
            message: `Working directory is valid: ${cwd}`,
        });
    }
    catch (err) {
        checks.push({
            code: "orager_cwd_invalid",
            level: "error",
            message: err instanceof Error ? err.message : "Invalid working directory",
            detail: cwd,
        });
    }
    // Validate orager binary
    const cwdValid = !checks.some((c) => c.code === "orager_cwd_invalid");
    if (cwdValid) {
        try {
            await ensureCommandResolvable(cliPath, cwd, runtimeEnv);
            checks.push({
                code: "orager_command_resolvable",
                level: "info",
                message: `orager CLI is executable: ${cliPath}`,
            });
        }
        catch (err) {
            checks.push({
                code: "orager_command_unresolvable",
                level: "warn",
                message: err instanceof Error ? err.message : "orager CLI is not executable",
                detail: cliPath,
                hint: "Install orager (npm install -g @paperclipai/orager) or set cliPath in the adapter config.",
            });
        }
    }
    // Hello probe — only if API key and orager are both available
    const canRunProbe = apiKey &&
        cwdValid &&
        checks.every((c) => c.code !== "orager_command_unresolvable" &&
            c.code !== "openrouter_api_key_missing" &&
            c.code !== "openrouter_api_key_invalid");
    if (canRunProbe) {
        const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
        const model = asString(config.model, "deepseek/deepseek-chat-v3-0324");
        const probeEnv = {
            ...runtimeEnv,
            OPENROUTER_API_KEY: apiKey,
            ORAGER_API_KEY: apiKey,
        };
        // Build minimal probe args (no --max-turns so orager uses its default)
        const probeArgs = [
            "--print", "-",
            "--output-format", "stream-json",
            "--verbose",
            "--model", model,
            "--max-turns", "1",
        ];
        if (dangerouslySkipPermissions)
            probeArgs.push("--dangerously-skip-permissions");
        // Temporarily override args for the probe by running manually
        const probe = await runOragerProbe(cliPath, cwd, probeEnv);
        const { resultText } = parseOragerProbeResult(probe.stdout);
        const detail = resultText ||
            firstNonEmptyLine(probe.stderr) ||
            firstNonEmptyLine(probe.stdout) ||
            undefined;
        if (probe.timedOut) {
            checks.push({
                code: "orager_hello_probe_timed_out",
                level: "warn",
                message: "Orager hello probe timed out.",
                hint: "Retry the probe. If this persists, verify orager can run `Respond with hello` from this directory manually.",
            });
        }
        else if ((probe.exitCode ?? 1) === 0) {
            const hasHello = /\bhello\b/i.test(resultText);
            checks.push({
                code: hasHello ? "orager_hello_probe_passed" : "orager_hello_probe_unexpected_output",
                level: hasHello ? "info" : "warn",
                message: hasHello
                    ? "Orager hello probe succeeded."
                    : "Orager probe ran but did not return `hello` as expected.",
                ...(detail ? { detail: String(detail).replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
            });
        }
        else {
            checks.push({
                code: "orager_hello_probe_failed",
                level: "error",
                message: "Orager hello probe failed.",
                ...(detail ? { detail: String(detail).replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
                hint: `Run \`${cliPath} --print - --output-format stream-json --verbose\` manually in ${cwd} and prompt \`Respond with hello\` to debug.`,
            });
        }
    }
    // ── Daemon health check (when daemonUrl is configured) ───────────────────
    const daemonUrl = asString(config.daemonUrl, "").replace(/\/$/, "");
    if (daemonUrl) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3_000);
            let healthRes;
            try {
                healthRes = await fetch(`${daemonUrl}/health`, { signal: controller.signal });
            }
            finally {
                clearTimeout(timer);
            }
            if (healthRes.ok) {
                const body = await healthRes.json();
                const isOk = body.status === "ok";
                checks.push({
                    code: isOk ? "daemon_health_ok" : "daemon_health_unexpected",
                    level: isOk ? "info" : "warn",
                    message: isOk
                        ? `Daemon at ${daemonUrl} is healthy (${body.activeRuns ?? "?"} / ${body.maxConcurrent ?? "?"} runs active).`
                        : `Daemon at ${daemonUrl} returned unexpected status: ${JSON.stringify(body).slice(0, 120)}`,
                });
            }
            else {
                checks.push({
                    code: "daemon_health_error",
                    level: "warn",
                    message: `Daemon at ${daemonUrl} returned HTTP ${healthRes.status}.`,
                    hint: "Start the daemon with: orager --serve",
                });
            }
        }
        catch (err) {
            checks.push({
                code: "daemon_unreachable",
                level: "warn",
                message: `Daemon at ${daemonUrl} is not reachable.`,
                detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
                hint: "Start the daemon with: orager --serve, or remove daemonUrl from config if daemon mode is not intended.",
            });
        }
    }
    return {
        adapterType: ctx.adapterType,
        status: summarizeStatus(checks),
        checks,
        testedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=test.js.map