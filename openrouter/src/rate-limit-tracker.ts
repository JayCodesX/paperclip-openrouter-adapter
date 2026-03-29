/**
 * Tracks rate-limit state observed by the adapter.
 *
 * Mirrors the RateLimitTracker in orager so that callers who use both
 * packages have a consistent API. The adapter updates this tracker from
 * 429 responses returned by the orager daemon (Retry-After header), and
 * from any X-RateLimit-* headers forwarded in daemon responses.
 *
 * The process-level singleton `processRateLimitTracker` is updated
 * automatically during daemon calls. Callers can import it to read current
 * rate-limit state without coupling directly to orager internals.
 */

export interface RateLimitState {
  limitRequests: number;
  remainingRequests: number;
  limitTokens: number;
  remainingTokens: number;
  resetRequestsAt: Date | null;
  resetTokensAt: Date | null;
  updatedAt: Date;
}

const WARNING_THRESHOLD_PCT = 0.1; // warn at 10% remaining

export class RateLimitTracker {
  private _state: RateLimitState | null = null;
  /** Unix-ms timestamp of the last 429 response seen, or null. */
  private _lastRateLimitAt: number | null = null;
  /** Retry-After wait in ms extracted from the last 429 response. */
  private _retryAfterMs: number | null = null;

  /**
   * Update tracker state from X-RateLimit-* response headers.
   * Compatible with both `Headers` objects and plain `Record<string, string | null>`.
   */
  updateFromHeaders(headers: Headers | Record<string, string | null>): void {
    const get = (k: string): string | null =>
      typeof (headers as Headers).get === "function"
        ? (headers as Headers).get(k)
        : (headers as Record<string, string | null>)[k] ?? null;

    const limitReq    = parseInt(get("x-ratelimit-limit-requests")    ?? "", 10);
    const remainReq   = parseInt(get("x-ratelimit-remaining-requests") ?? "", 10);
    const limitTok    = parseInt(get("x-ratelimit-limit-tokens")       ?? "", 10);
    const remainTok   = parseInt(get("x-ratelimit-remaining-tokens")   ?? "", 10);
    const resetReqStr = get("x-ratelimit-reset-requests");
    const resetTokStr = get("x-ratelimit-reset-tokens");

    if (!Number.isFinite(limitReq) || !Number.isFinite(remainReq) ||
        !Number.isFinite(limitTok) || !Number.isFinite(remainTok)) return;
    if (limitReq === 0 && limitTok === 0) return;

    this._state = {
      limitRequests:     limitReq,
      remainingRequests: remainReq,
      limitTokens:       limitTok,
      remainingTokens:   remainTok,
      resetRequestsAt:   resetReqStr ? new Date(resetReqStr) : null,
      resetTokensAt:     resetTokStr ? new Date(resetTokStr) : null,
      updatedAt:         new Date(),
    };
  }

  /**
   * Record a 429 rate-limit response with an optional Retry-After value.
   * @param retryAfterMs  Milliseconds to wait before retrying (from Retry-After header).
   */
  recordRateLimit(retryAfterMs: number | null): void {
    this._lastRateLimitAt = Date.now();
    this._retryAfterMs = retryAfterMs;
  }

  /** Clear any recorded 429 state (call after a successful response). */
  clearRateLimit(): void {
    this._lastRateLimitAt = null;
    this._retryAfterMs = null;
  }

  getState(): RateLimitState | null { return this._state; }

  /** Returns true when either requests or tokens remaining is below the warning threshold. */
  isNearLimit(): boolean {
    if (!this._state) return false;
    if (this._state.limitRequests > 0 &&
        this._state.remainingRequests / this._state.limitRequests < WARNING_THRESHOLD_PCT) return true;
    if (this._state.limitTokens > 0 &&
        this._state.remainingTokens / this._state.limitTokens < WARNING_THRESHOLD_PCT) return true;
    return false;
  }

  /** Returns true if we are currently inside a rate-limit back-off window. */
  isRateLimited(): boolean {
    if (this._lastRateLimitAt === null || this._retryAfterMs === null) return false;
    return Date.now() - this._lastRateLimitAt < this._retryAfterMs;
  }

  /** Remaining milliseconds to wait in the current back-off window, or 0 if not rate-limited. */
  remainingWaitMs(): number {
    if (this._lastRateLimitAt === null || this._retryAfterMs === null) return 0;
    return Math.max(0, this._retryAfterMs - (Date.now() - this._lastRateLimitAt));
  }

  summary(): string {
    if (!this._state && !this._lastRateLimitAt) return "no rate limit data";
    const parts: string[] = [];
    if (this._state) {
      const reqPct = this._state.limitRequests > 0
        ? ` (${Math.round((this._state.remainingRequests / this._state.limitRequests) * 100)}% req remaining)`
        : "";
      const tokPct = this._state.limitTokens > 0
        ? ` (${Math.round((this._state.remainingTokens / this._state.limitTokens) * 100)}% tok remaining)`
        : "";
      parts.push(
        `${this._state.remainingRequests}/${this._state.limitRequests} requests${reqPct}, ` +
        `${this._state.remainingTokens}/${this._state.limitTokens} tokens${tokPct}`,
      );
    }
    if (this.isRateLimited()) {
      parts.push(`rate-limited, retry in ${this.remainingWaitMs()}ms`);
    }
    return parts.join("; ") || "no rate limit data";
  }
}

/** Process-level singleton updated automatically during adapter daemon calls. */
export const processRateLimitTracker = new RateLimitTracker();
