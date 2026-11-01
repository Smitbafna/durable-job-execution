import { AppError, AppErrorCode } from "../errors.js";

export enum FailureClassification {
  NonRetryable = "NON_RETRYABLE",
  Retryable = "RETRYABLE",
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readDetailRetryable(value: unknown): boolean | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  const details = asRecord(record.details);
  const carriers: Array<Record<string, unknown> | null> = [details, record];
  for (const carrier of carriers) {
    if (carrier === null) continue;
    if (typeof carrier.retryable === "boolean") return carrier.retryable;
    const kind = carrier.failureKind ?? carrier.kind ?? carrier.failureType;
    if (typeof kind === "string") {
      const lower = kind.toLowerCase();
      if (
        lower.includes("retryable") ||
        lower.includes("daemon") ||
        lower.includes("infrastructure") ||
        lower.includes("temporary")
      ) {
        return true;
      }
      if (
        lower.includes("non_retryable") ||
        lower.includes("non-retryable") ||
        lower.includes("nonretryable") ||
        lower.includes("invalid") ||
        lower.includes("validation") ||
        lower.includes("ownership_lost") ||
        lower.includes("ownership-lost")
      ) {
        return false;
      }
    }
  }
  return undefined;
}

function isExecutionResultLike(value: unknown): value is {
  exitCode: number;
  stderr?: string;
} {
  const record = asRecord(value);
  return record !== null && typeof record.exitCode === "number";
}

const NON_RETRYABLE_APP_ERROR_CODES = new Set<AppErrorCode>([
  AppErrorCode.ValidationError,
  AppErrorCode.UnsupportedJobType,
  AppErrorCode.NotFound,
  AppErrorCode.PayloadTooLarge,
  AppErrorCode.UnsupportedMediaType,
]);

const DOCKER_INFRASTRUCTURE_HINTS = [
  "docker daemon",
  "cannot connect to the docker daemon",
  "is the docker daemon running",
  "connection refused",
  "econnrefused",
  "enoent",
  "temporary",
  "service unavailable",
  "503",
];

function looksLikeDockerInfrastructureFailure(message: string): boolean {
  const lower = message.toLowerCase();
  if (
    lower.includes("cannot connect to the docker daemon") ||
    lower.includes("is the docker daemon running")
  ) {
    return true;
  }
  if (!lower.includes("docker")) {
    return false;
  }
  return DOCKER_INFRASTRUCTURE_HINTS.some((hint) => lower.includes(hint));
}

export function classifyFailure(value: unknown): FailureClassification {
  if (isExecutionResultLike(value)) {
    return FailureClassification.NonRetryable;
  }

  if (value instanceof AppError) {
    const detailRetryable = readDetailRetryable(value);
    if (detailRetryable === true) return FailureClassification.Retryable;
    if (detailRetryable === false) return FailureClassification.NonRetryable;

    if (NON_RETRYABLE_APP_ERROR_CODES.has(value.code)) {
      return FailureClassification.NonRetryable;
    }

    if (
      value.code === AppErrorCode.Conflict &&
      /ownership/i.test(value.message)
    ) {
      return FailureClassification.NonRetryable;
    }

    const message = value.message ?? "";
    if (looksLikeDockerInfrastructureFailure(String(message))) {
      return FailureClassification.Retryable;
    }

    return FailureClassification.NonRetryable;
  }

  if (value instanceof Error) {
    const detailRetryable = readDetailRetryable(value);
    if (detailRetryable === true) return FailureClassification.Retryable;
    if (detailRetryable === false) return FailureClassification.NonRetryable;

    const message = value.message ?? "";
    if (looksLikeDockerInfrastructureFailure(String(message))) {
      return FailureClassification.Retryable;
    }
    return FailureClassification.NonRetryable;
  }

  const record = asRecord(value);
  if (record !== null) {
    const detailRetryable = readDetailRetryable(record);
    if (detailRetryable === true) return FailureClassification.Retryable;
    if (detailRetryable === false) return FailureClassification.NonRetryable;

    if (typeof record.message === "string") {
      if (looksLikeDockerInfrastructureFailure(record.message)) {
        return FailureClassification.Retryable;
      }
    }
  }

  return FailureClassification.NonRetryable;
}

export function isRetryable(value: unknown): boolean {
  return classifyFailure(value) === FailureClassification.Retryable;
}

export const classifyJobFailure = classifyFailure;
export const failureClassification = classifyFailure;
