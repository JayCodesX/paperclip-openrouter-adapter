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
export declare class RateLimitTracker {
    private _state;
    /** Unix-ms timestamp of the last 429 response seen, or null. */
    private _lastRateLimitAt;
    /** Retry-After wait in ms extracted from the last 429 response. */
    private _retryAfterMs;
    /**
     * Update tracker state from X-RateLimit-* response headers.
     * Compatible with both `Headers` objects and plain `Record<string, string | null>`.
     */
    updateFromHeaders(headers: Headers | Record<string, string | null>): void;
    /**
     * Record a 429 rate-limit response with an optional Retry-After value.
     * @param retryAfterMs  Milliseconds to wait before retrying (from Retry-After header).
     */
    recordRateLimit(retryAfterMs: number | null): void;
    /** Clear any recorded 429 state (call after a successful response). */
    clearRateLimit(): void;
    getState(): RateLimitState | null;
    /** Returns true when either requests or tokens remaining is below the warning threshold. */
    isNearLimit(): boolean;
    /** Returns true if we are currently inside a rate-limit back-off window. */
    isRateLimited(): boolean;
    /** Remaining milliseconds to wait in the current back-off window, or 0 if not rate-limited. */
    remainingWaitMs(): number;
    summary(): string;
}
/** Process-level singleton updated automatically during adapter daemon calls. */
export declare const processRateLimitTracker: RateLimitTracker;
//# sourceMappingURL=rate-limit-tracker.d.ts.map