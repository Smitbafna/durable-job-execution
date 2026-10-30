/**
 * Job Engine — supported job types, their payload contracts, and expected
 * result shapes.
 *
 * This module is the **contract** that future workers implement. In Week 1 only
 * the input schema is validated and the result shape is documented; no job is
 * executed (see `service/jobService.ts`).
 */

import { AppError, AppErrorCode } from "../errors.js";

/** The one job type supported in Week 1. Extended in later milestones. */
export const SUPPORTED_JOB_TYPES = ["sum_numbers"] as const;
export type JobType = (typeof SUPPORTED_JOB_TYPES)[number];

/**
 * Returns true when `value` is a supported job type string. This predicate is
 * the single source of truth for "which job types exist" — both the HTTP layer
 * and the service use it rather than redefining the list.
 */
export function isSupportedJobType(value: unknown): value is JobType {
  return typeof value === "string" && (SUPPORTED_JOB_TYPES as readonly string[]).includes(value);
}

// --- sum_numbers ---

/** Input contract for `sum_numbers`: a list of finite numbers. */
export interface SumNumbersPayload {
  readonly numbers: number[];
}

/** Expected result shape for `sum_numbers` (produced by the future worker). */
export interface SumNumbersResult {
  readonly sum: number;
}

/** Payload type validated for all known job types (union, extensible). */
export type ValidatedPayload = SumNumbersPayload;

/** Result type produced by all known job types (union, extensible). */
export type JobResult = SumNumbersResult;

/** Dispatch type for a job handler: turns a (already validated) payload into a result. */
export type JobHandler = (payload: unknown) => JobResult | Promise<JobResult>;

export const MAX_NUMBERS = 100_000;

export interface JobTypeDefinition {
  readonly type: JobType;
  readonly name: string;
  /** Human-readable description of the result shape returned when the job succeeds. */
  readonly resultShape: string;
  /** Validates an untrusted payload for this job type. Returns the typed payload or an AppError. */
  validatePayload: (payload: unknown) => ValidatedPayload | AppError;
}

export const SUM_NUMBERS_TYPE: JobTypeDefinition = {
  type: "sum_numbers",
  name: "Sum Numbers",
  resultShape: "{ sum: number } — the arithmetic sum of `payload.numbers`",
  validatePayload: validateSumNumbersPayload,
} as const;

export const JOB_TYPES: Readonly<Record<JobType, JobTypeDefinition>> = {
  sum_numbers: SUM_NUMBERS_TYPE,
} as const;

/**
 * Validates an untrusted `sum_numbers` payload. Accepts any JSON object with a
 * `numbers` field that is an array of finite numbers. Returns a defensive copy
 * of the normalized payload on success.
 */
export function validateSumNumbersPayload(
  payload: unknown,
): ValidatedPayload | AppError {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      "payload must be a JSON object",
    );
  }
  const p = payload as Record<string, unknown>;
  if (!("numbers" in p)) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      "payload.numbers is required",
    );
  }
  const { numbers } = p;
  if (!Array.isArray(numbers)) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      "payload.numbers must be an array",
    );
  }
  if (numbers.length > MAX_NUMBERS) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      `payload.numbers must not exceed ${MAX_NUMBERS} elements`,
    );
  }
  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i];
    if (typeof n !== "number" || !Number.isFinite(n)) {
      return AppError.badRequest(
        AppErrorCode.ValidationError,
        `payload.numbers[${i}] must be a finite number`,
      );
    }
  }
  return { numbers: numbers.slice() } as ValidatedPayload;
}

/**
 * Looks up the type definition for a job type. Throws `UNSUPPORTED_JOB_TYPE`
 * (400) for unknown types — used by the service so *supported-type* rules live
 * in exactly one place (`JOB_TYPES` / `SUPPORTED_JOB_TYPES`).
 */
export function describeJobType(type: string): JobTypeDefinition {
  const def = JOB_TYPES[type as JobType] as JobTypeDefinition | undefined;
  if (def === undefined) {
    throw new AppError(
      AppErrorCode.UnsupportedJobType,
      400,
      `Unsupported job type: ${type}`,
    );
  }
  return def;
}
