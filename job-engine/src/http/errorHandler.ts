/**
 * Job Engine — centralized Express error handler.
 *
 * Mounted last. Guarantees a single, consistent JSON error shape and prevents
 * internal details (stack traces, SQL, credentials) from leaking to clients.
 */

import type { ErrorRequestHandler } from "express";
import { AppError } from "../errors.js";
import { serializeError } from "./serializers.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(serializeError(err));
    return;
  }

  // JSON body parse failures arrive here as SyntaxError (normalized to 400).
  if (err instanceof SyntaxError) {
    res.status(400).json(
      serializeError({
        code: "VALIDATION_ERROR",
        message: "Request body is not valid JSON",
      }),
    );
    return;
  }

  // Unexpected errors: log a sanitized summary server-side only.
  const summary = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error("[job-engine] Unhandled error:", summary);
  res.status(500).json(
    serializeError({ code: "INTERNAL_ERROR", message: "Internal server error" }),
  );
};
