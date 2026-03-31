/**
 * Vitest global setup/teardown — kills orphaned orager processes on exit.
 *
 * Integration tests spawn real orager CLI processes. If a test times out or
 * the runner is killed, those processes can survive as orphans. This teardown
 * finds and kills any that are still running.
 */
import { execSync } from "node:child_process";

export function setup(): void {
  // Nothing to do on setup — teardown handles cleanup.
}

export function teardown(): void {
  // Kill any orager wrapper scripts left over from integration tests
  killByPattern("orager-wrapper");

  // Kill any orager dist/index.js processes spawned by tests
  // (these use --config-file with a temp path, distinguishing them from
  // user-started orager instances)
  killByPattern("orager-config-");
}

function killByPattern(pattern: string): void {
  try {
    const raw = execSync(
      `pgrep -f "${pattern}" 2>/dev/null || true`,
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    if (!raw) return;

    const pids = raw.split("\n").filter(Boolean).map(Number).filter((n) => !isNaN(n) && n !== process.pid);
    if (pids.length === 0) return;

    // SIGTERM first
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }

    // Grace period
    try { execSync("sleep 2", { timeout: 5000 }); } catch { /* ignore */ }

    // SIGKILL survivors
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }

    process.stderr.write(`[global-setup] cleaned up ${pids.length} orphaned process(es)\n`);
  } catch {
    // Best-effort — don't fail the test run if cleanup fails
  }
}
