/**
 * JWT utility for authenticating to the orager daemon.
 * Mirrors the HS256 implementation in orager/src/jwt.ts — must stay in sync with token format.
 * Centralized here to avoid duplication across execute-cli.ts and sessions.ts.
 */
import crypto from "node:crypto";

const TOKEN_TTL_SECONDS = 900; // 15 minutes

export function mintDaemonJwt(signingKey: string, agentId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ agentId, scope: "run", iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac("sha256", signingKey).update(data).digest("base64url");
  return `${data}.${sig}`;
}
