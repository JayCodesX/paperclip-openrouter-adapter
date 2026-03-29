/**
 * Unit tests for the adapter's RateLimitTracker class and processRateLimitTracker
 * singleton (src/rate-limit-tracker.ts).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RateLimitTracker, processRateLimitTracker } from "../src/rate-limit-tracker.js";

// ── RateLimitTracker class ────────────────────────────────────────────────────

describe("RateLimitTracker — initial state", () => {
  it("getState() returns null before any updates", () => {
    const tracker = new RateLimitTracker();
    expect(tracker.getState()).toBeNull();
  });

  it("isNearLimit() returns false before any updates", () => {
    const tracker = new RateLimitTracker();
    expect(tracker.isNearLimit()).toBe(false);
  });

  it("isRateLimited() returns false before any 429 is recorded", () => {
    const tracker = new RateLimitTracker();
    expect(tracker.isRateLimited()).toBe(false);
  });

  it("remainingWaitMs() returns 0 before any 429 is recorded", () => {
    const tracker = new RateLimitTracker();
    expect(tracker.remainingWaitMs()).toBe(0);
  });

  it("summary() returns 'no rate limit data' before any updates", () => {
    const tracker = new RateLimitTracker();
    expect(tracker.summary()).toBe("no rate limit data");
  });
});

describe("RateLimitTracker — updateFromHeaders()", () => {
  it("parses valid X-RateLimit-* headers and stores state", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "80",
      "x-ratelimit-limit-tokens": "200000",
      "x-ratelimit-remaining-tokens": "150000",
    });
    const state = tracker.getState();
    expect(state).not.toBeNull();
    expect(state!.limitRequests).toBe(100);
    expect(state!.remainingRequests).toBe(80);
    expect(state!.limitTokens).toBe(200000);
    expect(state!.remainingTokens).toBe(150000);
  });

  it("ignores headers when all four required values are missing", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({ "content-type": "application/json" });
    expect(tracker.getState()).toBeNull();
  });

  it("ignores update when both limits are 0 (no quota header)", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "0",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-limit-tokens": "0",
      "x-ratelimit-remaining-tokens": "0",
    });
    expect(tracker.getState()).toBeNull();
  });

  it("parses reset timestamps as Date objects", () => {
    const tracker = new RateLimitTracker();
    const resetTime = new Date(Date.now() + 60_000).toISOString();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "50",
      "x-ratelimit-limit-tokens": "200000",
      "x-ratelimit-remaining-tokens": "100000",
      "x-ratelimit-reset-requests": resetTime,
      "x-ratelimit-reset-tokens": resetTime,
    });
    const state = tracker.getState();
    expect(state!.resetRequestsAt).toBeInstanceOf(Date);
    expect(state!.resetTokensAt).toBeInstanceOf(Date);
  });

  it("works with a Headers object (fetch API style)", () => {
    const tracker = new RateLimitTracker();
    const headers = new Headers({
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-requests": "10",
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "5000",
    });
    tracker.updateFromHeaders(headers);
    const state = tracker.getState();
    expect(state!.limitRequests).toBe(50);
    expect(state!.remainingRequests).toBe(10);
  });

  it("updatedAt is set to approximately now", () => {
    const before = Date.now();
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "50",
      "x-ratelimit-limit-tokens": "200000",
      "x-ratelimit-remaining-tokens": "100000",
    });
    const after = Date.now();
    const updatedAt = tracker.getState()!.updatedAt.getTime();
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(after);
  });
});

describe("RateLimitTracker — isNearLimit()", () => {
  it("returns false when remaining requests is above 10% threshold", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "50",
      "x-ratelimit-limit-tokens": "200000",
      "x-ratelimit-remaining-tokens": "100000",
    });
    expect(tracker.isNearLimit()).toBe(false);
  });

  it("returns true when remaining requests drops below 10% threshold", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "5", // 5% — below 10% threshold
      "x-ratelimit-limit-tokens": "200000",
      "x-ratelimit-remaining-tokens": "100000",
    });
    expect(tracker.isNearLimit()).toBe(true);
  });

  it("returns true when remaining tokens drops below 10% threshold", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "80",
      "x-ratelimit-limit-tokens": "200000",
      "x-ratelimit-remaining-tokens": "5000", // 2.5% — below threshold
    });
    expect(tracker.isNearLimit()).toBe(true);
  });
});

describe("RateLimitTracker — recordRateLimit() / clearRateLimit() / isRateLimited()", () => {
  it("isRateLimited() returns true immediately after recordRateLimit()", () => {
    const tracker = new RateLimitTracker();
    tracker.recordRateLimit(5000);
    expect(tracker.isRateLimited()).toBe(true);
  });

  it("remainingWaitMs() returns positive value inside back-off window", () => {
    const tracker = new RateLimitTracker();
    tracker.recordRateLimit(5000);
    const remaining = tracker.remainingWaitMs();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
  });

  it("clearRateLimit() ends the back-off window immediately", () => {
    const tracker = new RateLimitTracker();
    tracker.recordRateLimit(60_000);
    expect(tracker.isRateLimited()).toBe(true);
    tracker.clearRateLimit();
    expect(tracker.isRateLimited()).toBe(false);
    expect(tracker.remainingWaitMs()).toBe(0);
  });

  it("recordRateLimit(null) does not start a back-off window", () => {
    const tracker = new RateLimitTracker();
    tracker.recordRateLimit(null);
    expect(tracker.isRateLimited()).toBe(false);
  });

  it("isRateLimited() returns false after the back-off window expires", () => {
    vi.useFakeTimers();
    const tracker = new RateLimitTracker();
    tracker.recordRateLimit(1000);
    expect(tracker.isRateLimited()).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(tracker.isRateLimited()).toBe(false);
    vi.useRealTimers();
  });
});

describe("RateLimitTracker — summary()", () => {
  it("includes request and token counts when state is available", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "100",
      "x-ratelimit-remaining-requests": "80",
      "x-ratelimit-limit-tokens": "200000",
      "x-ratelimit-remaining-tokens": "160000",
    });
    const s = tracker.summary();
    expect(s).toContain("80/100");
    expect(s).toContain("160000/200000");
  });

  it("includes rate-limited status when inside back-off window", () => {
    const tracker = new RateLimitTracker();
    tracker.recordRateLimit(5000);
    expect(tracker.summary()).toMatch(/rate.limited/i);
  });
});

// ── processRateLimitTracker singleton ─────────────────────────────────────────

describe("processRateLimitTracker singleton", () => {
  afterEach(() => {
    // Reset singleton state between tests
    processRateLimitTracker.clearRateLimit();
  });

  it("is exported and is a RateLimitTracker instance", () => {
    expect(processRateLimitTracker).toBeInstanceOf(RateLimitTracker);
  });

  it("starts with no rate-limit back-off active", () => {
    expect(processRateLimitTracker.isRateLimited()).toBe(false);
  });

  it("recordRateLimit() and clearRateLimit() mutate shared state", () => {
    processRateLimitTracker.recordRateLimit(10_000);
    expect(processRateLimitTracker.isRateLimited()).toBe(true);
    processRateLimitTracker.clearRateLimit();
    expect(processRateLimitTracker.isRateLimited()).toBe(false);
  });
});

// ── updateFromHeaders — partial / malformed headers ───────────────────────────

describe("RateLimitTracker — updateFromHeaders() with partial or malformed headers", () => {
  it("ignores update when only request-limit headers are present (token fields missing)", () => {
    const tracker = new RateLimitTracker();
    // Missing x-ratelimit-limit-tokens and x-ratelimit-remaining-tokens
    // → parseInt("", 10) = NaN → isFinite(NaN) = false → early return
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests":     "100",
      "x-ratelimit-remaining-requests": "80",
    });
    expect(tracker.getState()).toBeNull();
  });

  it("ignores update when only token-limit headers are present (request fields missing)", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-tokens":     "200000",
      "x-ratelimit-remaining-tokens": "150000",
    });
    expect(tracker.getState()).toBeNull();
  });

  it("ignores update when exactly one of the four required headers is missing", () => {
    const tracker = new RateLimitTracker();
    // Missing x-ratelimit-remaining-tokens — NaN fails isFinite
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests":     "100",
      "x-ratelimit-remaining-requests": "80",
      "x-ratelimit-limit-tokens":       "200000",
      // remaining-tokens intentionally absent
    });
    expect(tracker.getState()).toBeNull();
  });

  it("ignores update when a header value is a non-numeric string", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests":     "not-a-number",
      "x-ratelimit-remaining-requests": "80",
      "x-ratelimit-limit-tokens":       "200000",
      "x-ratelimit-remaining-tokens":   "150000",
    });
    expect(tracker.getState()).toBeNull();
  });

  it("ignores update when a header value is an empty string", () => {
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests":     "",
      "x-ratelimit-remaining-requests": "80",
      "x-ratelimit-limit-tokens":       "200000",
      "x-ratelimit-remaining-tokens":   "150000",
    });
    expect(tracker.getState()).toBeNull();
  });

  it("accepts update when remaining-requests is 0 and limit-requests is > 0", () => {
    // 0 is a valid finite integer — this is an exhausted-quota scenario, not missing data
    const tracker = new RateLimitTracker();
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests":     "100",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-limit-tokens":       "200000",
      "x-ratelimit-remaining-tokens":   "50000",
    });
    const state = tracker.getState();
    expect(state).not.toBeNull();
    expect(state!.remainingRequests).toBe(0);
    expect(state!.limitRequests).toBe(100);
  });

  it("existing state is preserved when a subsequent update is ignored due to partial headers", () => {
    const tracker = new RateLimitTracker();
    // First update: valid
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests":     "100",
      "x-ratelimit-remaining-requests": "90",
      "x-ratelimit-limit-tokens":       "200000",
      "x-ratelimit-remaining-tokens":   "180000",
    });
    const first = tracker.getState();
    expect(first).not.toBeNull();

    // Second update: partial — should be ignored, previous state preserved
    tracker.updateFromHeaders({
      "x-ratelimit-limit-requests": "100",
    });
    expect(tracker.getState()).toEqual(first);
  });
});
