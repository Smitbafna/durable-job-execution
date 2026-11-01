import { AppError, AppErrorCode } from "../errors.js";

export interface RetryPolicyConfig {
  readonly initialDelayMs: number;
  readonly multiplier: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY_CONFIG: RetryPolicyConfig = {
  initialDelayMs: 5000,
  multiplier: 2,
  maxDelayMs: 300000,
};

export function validateRetryPolicyConfig(config: RetryPolicyConfig): void {
  if (
    typeof config !== "object" ||
    config === null ||
    !Number.isFinite(config.initialDelayMs) ||
    !Number.isInteger(config.initialDelayMs) ||
    config.initialDelayMs <= 0 ||
    !Number.isFinite(config.multiplier) ||
    config.multiplier <= 1 ||
    !Number.isFinite(config.maxDelayMs) ||
    !Number.isInteger(config.maxDelayMs) ||
    config.maxDelayMs < config.initialDelayMs
  ) {
    throw new AppError(
      AppErrorCode.ValidationError,
      400,
      "Invalid retry policy configuration",
    );
  }
}

function validateAttemptCount(attemptCount: number): void {
  if (
    typeof attemptCount !== "number" ||
    !Number.isFinite(attemptCount) ||
    !Number.isInteger(attemptCount) ||
    attemptCount < 1
  ) {
    throw new AppError(
      AppErrorCode.ValidationError,
      400,
      "Invalid attempt count",
    );
  }
}

export type RetryPolicyResult =
  | {
      readonly decision: "retry";
      readonly retryable: true;
      readonly attemptCount: number;
      readonly delayMs: number;
      readonly nextAttemptAt: Date;
    }
  | {
      readonly decision: "terminal";
      readonly retryable: false;
      readonly reason: "non_retryable" | "exhausted";
    };

export function calculateRetryDelayMs(
  attemptCount: number,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG,
): number {
  validateRetryPolicyConfig(config);
  validateAttemptCount(attemptCount);

  const exponent = attemptCount - 1;
  const delay = config.initialDelayMs * config.multiplier ** exponent;
  return Math.min(delay, config.maxDelayMs);
}

export function calculateNextAttemptAt(
  attemptCount: number,
  config: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG,
  now: Date = new Date(),
): Date {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new AppError(AppErrorCode.ValidationError, 400, "Invalid timestamp");
  }
  const delayMs = calculateRetryDelayMs(attemptCount, config);
  return new Date(now.getTime() + delayMs);
}

export interface DecideRetryInput {
  readonly classification: FailureClassification;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly config?: RetryPolicyConfig;
  readonly now?: Date;
}

import { FailureClassification } from "./failureClassification.js";

export function decideRetry(input: DecideRetryInput): RetryPolicyResult {
  const config = input.config ?? DEFAULT_RETRY_POLICY_CONFIG;
  validateRetryPolicyConfig(config);

  if (
    typeof input.attemptCount !== "number" ||
    !Number.isFinite(input.attemptCount) ||
    !Number.isInteger(input.attemptCount) ||
    input.attemptCount < 1
  ) {
    throw new AppError(AppErrorCode.ValidationError, 400, "Invalid attempt count");
  }
  if (
    typeof input.maxAttempts !== "number" ||
    !Number.isFinite(input.maxAttempts) ||
    !Number.isInteger(input.maxAttempts) ||
    input.maxAttempts < 1
  ) {
    throw new AppError(AppErrorCode.ValidationError, 400, "Invalid max attempts");
  }

  if (input.classification !== FailureClassification.Retryable) {
    return { decision: "terminal", retryable: false, reason: "non_retryable" };
  }

  if (input.attemptCount >= input.maxAttempts) {
    return { decision: "terminal", retryable: false, reason: "exhausted" };
  }

  const now = input.now ?? new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new AppError(AppErrorCode.ValidationError, 400, "Invalid timestamp");
  }

  const delayMs = calculateRetryDelayMs(input.attemptCount, config);
  return {
    decision: "retry",
    retryable: true,
    attemptCount: input.attemptCount,
    delayMs,
    nextAttemptAt: new Date(now.getTime() + delayMs),
  };
}

// Common aliases.
export const calculateRetryDelay = calculateRetryDelayMs;
export const getRetryDelay = calculateRetryDelayMs;
export const computeBackoff = calculateRetryDelayMs;
export const backoffDelayMs = calculateRetryDelayMs;
export const calculateBackoff = calculateRetryDelayMs;
export const nextAttemptAt = calculateNextAttemptAt;
export const evaluateRetry = decideRetry;
export const retryDecision = decideRetry;