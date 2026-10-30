import { describe, it, expect } from "vitest";
import type { Response } from "express";
import { errorHandler } from "../http/errorHandler.js";
import { AppError, AppErrorCode } from "../errors.js";

/** Tiny fake Express response capturing the last status + body. */
function makeRes() {
  const state = { status: undefined as number | undefined, body: undefined as unknown };
  const res = {
    status(n: number) {
      state.status = n;
      return res;
    },
    json(b: unknown) {
      state.body = b;
      return res;
    },
  } as unknown as Response;
  return { res, state };
}

function run(err: unknown) {
  const { res, state } = makeRes();
  errorHandler(err, {} as never, res, () => undefined);
  return { status: state.status, body: state.body };
}

describe("errorHandler (error mapping)", () => {
  it("maps an AppError to its status code and error payload", () => {
    const { status, body } = run(
      new AppError(AppErrorCode.NotFound, 404, "Job not found"),
    );
    expect(status).toBe(404);
    expect(body).toEqual({
      error: { code: "NOT_FOUND", message: "Job not found" },
    });
  });

  it("includes details when present", () => {
    const { status, body } = run(
      AppError.badRequest(AppErrorCode.ValidationError, "bad", { field: "x" }),
    );
    expect(status).toBe(400);
    expect((body as { error: { details?: unknown } }).error.details).toEqual({
      field: "x",
    });
  });

  it("never includes details when absent", () => {
    const out = run(new AppError(AppErrorCode.NotFound, 404, "nope"));
    const details = (out.body as { error: { details?: unknown } }).error.details;
    expect(details).toBeUndefined();
  });

  it("maps a JSON SyntaxError to 400 ValidationError", () => {
    const { status, body } = run(new SyntaxError("Unexpected token"));
    expect(status).toBe(400);
    expect((body as { error: { code: string } }).error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("maps unexpected errors to 500 WITHOUT leaking the original message", () => {
    const { status, body } = run(new Error("internal secret stack trace"));
    expect(status).toBe(500);
    const json = body as { error: { code: string; message: string } };
    expect(json.error.code).toBe("INTERNAL_ERROR");
    expect(json.error.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("internal secret stack trace");
  });
});
