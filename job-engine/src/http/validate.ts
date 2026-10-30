/**
 * Job Engine — HTTP request validation.
 *
 * Validates only the *shape* of untrusted input at the boundary: the body is a
 * JSON object, `type` is a string, and `payload` is present. The domain rules —
 * which job types are supported and whether a given payload is valid for its
 * type — live in `domain/jobTypes.ts` and are enforced centrally by the service,
 * so they are not duplicated here.
 */

import { AppError, AppErrorCode } from "../errors.js";

export interface ParsedSubmitJobRequest {
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Validates the `POST /jobs` body shape. Returns the parsed request on success
 * or an `AppError` (400) for the first shape problem. Per-type/payload content
 * is validated later by {@link JobService.submitJob}.
 */
export function validateSubmitJobRequest(
  body: unknown,
): ParsedSubmitJobRequest | AppError {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      "Request body must be a JSON object",
    );
  }
  const b = body as Record<string, unknown>;

  if (b.type === undefined || b.type === null) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      "Field 'type' is required",
    );
  }
  if (typeof b.type !== "string") {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      "Field 'type' must be a string",
    );
  }

  if (b.payload === undefined) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      "Field 'payload' is required",
    );
  }

  return { type: b.type, payload: b.payload };
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates a `GET /jobs/:id` path parameter. Returns the UUID string on
 * success or an `AppError` (400) for malformed ids.
 */
export function validateJobId(value: unknown): string | AppError {
  if (typeof value !== "string" || !UUID_V4_RE.test(value)) {
    return new AppError(
      AppErrorCode.ValidationError,
      400,
      "Job id must be a UUID",
    );
  }
  return value;
}
