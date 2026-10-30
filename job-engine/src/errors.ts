/**
 * Centralized application errors.
 *
 * Every error that can be surfaced to a client is an `AppError` carrying a
 * stable, machine-readable `code`, an HTTP `statusCode`, a human `message`, and
 * optional structured `details`. The Express error handler serializes these into
 * a uniform JSON shape. Unexpected (non-`AppError`) exceptions are never leaked:
 * they are logged server-side only and returned to the client as a generic
 * 500. Sensitive values (credentials, raw SQL, full payloads) are never placed
 * in `details`.
 */

export enum AppErrorCode {
  ValidationError = "VALIDATION_ERROR",
  UnsupportedJobType = "UNSUPPORTED_JOB_TYPE",
  NotFound = "NOT_FOUND",
  Conflict = "CONFLICT",
  DbError = "DB_ERROR",
  Internal = "INTERNAL_ERROR",
}

export interface ErrorPayload {
  code: AppErrorCode;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    // Restore the prototype chain (needed for `instanceof` on down-level targets).
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static badRequest(code: AppErrorCode, message: string, details?: unknown): AppError {
    return new AppError(code, 400, message, details);
  }

  static notFound(message: string): AppError {
    return new AppError(AppErrorCode.NotFound, 404, message);
  }

  static dbError(message: string): AppError {
    return new AppError(AppErrorCode.DbError, 503, message);
  }
}

/**
 * Normalizes any thrown value into an `AppError`. Database driver errors are
 * mapped to `DB_ERROR` (503) with a generic, safe message — never forwarding
 * raw server messages or credentials to the client.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof SyntaxError) {
    // JSON body parse failures surface from express.json() as SyntaxError.
    return AppError.badRequest(AppErrorCode.ValidationError, "Request body is not valid JSON");
  }
  // pg errors carry SQLSTATE codes on `code` but may also include host/port in
  // the message; we deliberately do NOT forward those to the client.
  return AppError.dbError("Database operation failed");
}
