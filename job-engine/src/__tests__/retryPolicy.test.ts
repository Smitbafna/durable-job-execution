import { describe, it, expect } from "vitest";
import { AppError } from "../errors.js";
import {
  FailureClassification,
} from "../domain/failureClassification.js";
import {
  DEFAULT_RETRY_POLICY_CONFIG,
  calculateRetryDelayMs,
  calculateNextAttemptAt,
  decideRetry,
  validateRetryPolicyConfig,
} from "../domain/retryPolicy.js";

describe("retry backoff policy", () => {
  it("first retry delay is 5 seconds", () => {
    expect(calculateRetryDelayMs(1)).toBe(5000);
  });

  it("second retry delay is 10 seconds", () => {
    expect(calculateRetryDelayMs(2)).toBe(10000);
  });

  it("third retry delay is 20 seconds", () => {
    expect(calculateRetryDelayMs(3)).toBe(20000);
  });

  it("delay doubles until capped", () => {
    expect(calculateRetryDelayMs(4)).toBe(40000);
    expect(calculateRetryDelayMs(5)).toBe(80000);
    expect(calculateRetryDelayMs(6)).toBe(160000);
  });

  it("delay never exceeds 300 seconds", () => {
    expect(calculateRetryDelayMs(7)).toBe(300000);
    expect(calculateRetryDelayMs(10)).toBe(300000);
  });

  it("attempt count and max-attempt boundaries are respected", () => {
    const retry = decideRetry({
      classification: FailureClassification.Retryable,
      attemptCount: 1,
      maxAttempts: 3,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(retry.decision).toBe("retry");

    const exhausted = decideRetry({
      classification: FailureClassification.Retryable,
      attemptCount: 3,
      maxAttempts: 3,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(exhausted.decision).toBe("terminal");
    if (exhausted.decision === "terminal") {
      expect(exhausted.reason).toBe("exhausted");
    }
  });

  it("non-retryable failures produce no retry schedule", () => {
    const result = decideRetry({
      classification: FailureClassification.NonRetryable,
      attemptCount: 1,
      maxAttempts: 3,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.decision).toBe("terminal");
    if (result.decision === "terminal") {
      expect(result.reason).toBe("non_retryable");
    }
  });

  it("exhausted attempts produce no retry schedule", () => {
    const result = decideRetry({
      classification: FailureClassification.Retryable,
      attemptCount: 3,
      maxAttempts: 3,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(result.decision).toBe("terminal");
  });

  it("injected timestamp produces the expected nextAttemptAt", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = decideRetry({
      classification: FailureClassification.Retryable,
      attemptCount: 1,
      maxAttempts: 3,
      now,
    });
    expect(result.decision).toBe("retry");
    if (result.decision === "retry") {
      expect(result.nextAttemptAt.getTime()).toBe(now.getTime() + 5000);
      expect(result.delayMs).toBe(5000);
    }
    expect(calculateNextAttemptAt(1, DEFAULT_RETRY_POLICY_CONFIG, now).getTime()).toBe(
      now.getTime() + 5000,
    );
  });

  it("invalid policy configuration is rejected", () => {
    expect(() =>
      validateRetryPolicyConfig({
        initialDelayMs: 0,
        multiplier: 2,
        maxDelayMs: 300000,
      }),
    ).toThrow(AppError);
    expect(() =>
      calculateRetryDelayMs(1, {
        initialDelayMs: 5000,
        multiplier: 1,
        maxDelayMs: 300000,
      }),
    ).toThrow(AppError);
  });

  it("invalid attempt counts are rejected", () => {
    expect(() => calculateRetryDelayMs(0)).toThrow(AppError);
    expect(() => calculateRetryDelayMs(1.5)).toThrow(AppError);
    expect(() =>
      decideRetry({
        classification: FailureClassification.Retryable,
        attemptCount: 0,
        maxAttempts: 3,
        now: new Date(),
      }),
    ).toThrow(AppError);
  });

  it("repeated calls with identical inputs are deterministic", () => {
    const a = calculateRetryDelayMs(3);
    const b = calculateRetryDelayMs(3);
    expect(a).toBe(b);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const r1 = decideRetry({
      classification: FailureClassification.Retryable,
      attemptCount: 2,
      maxAttempts: 5,
      now,
    });
    const r2 = decideRetry({
      classification: FailureClassification.Retryable,
      attemptCount: 2,
      maxAttempts: 5,
      now,
    });
    expect(r1).toEqual(r2);
  });
});