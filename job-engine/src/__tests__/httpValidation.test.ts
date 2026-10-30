import { describe, it, expect } from "vitest";
import {
  validateSubmitJobRequest,
  validateJobId,
} from "../http/validate.js";
import { AppError, AppErrorCode } from "../errors.js";

describe("validateSubmitJobRequest (shape only)", () => {
  it("accepts a well-formed request", () => {
    const r = validateSubmitJobRequest({
      type: "sum_numbers",
      payload: { numbers: [1, 2, 3] },
    });
    expect(r).not.toBeInstanceOf(AppError);
    if (!(r instanceof AppError)) {
      expect(r).toEqual({ type: "sum_numbers", payload: { numbers: [1, 2, 3] } });
    }
  });

  it("rejects non-object bodies", () => {
    expect(validateSubmitJobRequest(null)).toBeInstanceOf(AppError);
    expect(validateSubmitJobRequest("x")).toBeInstanceOf(AppError);
    expect(validateSubmitJobRequest([1, 2])).toBeInstanceOf(AppError);
    expect(validateSubmitJobRequest(undefined)).toBeInstanceOf(AppError);
  });

  it("rejects missing type", () => {
    const err = validateSubmitJobRequest({ payload: { numbers: [1] } });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(AppErrorCode.ValidationError);
  });

  it("rejects non-string type", () => {
    const err = validateSubmitJobRequest({ type: 123, payload: { numbers: [1] } });
    expect(err).toBeInstanceOf(AppError);
  });

  it("rejects missing payload", () => {
    const err = validateSubmitJobRequest({ type: "sum_numbers" });
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(AppErrorCode.ValidationError);
  });

  // Unsupported-type rejection happens in the service (single source of truth),
  // not the boundary validator — verify the boundary passes it through.
  it("passes an unsupported type through to the service for rejection", () => {
    const r = validateSubmitJobRequest({ type: "unknown", payload: {} });
    expect(r).not.toBeInstanceOf(AppError);
    if (!(r instanceof AppError)) {
      expect(r.type).toBe("unknown");
    }
  });
});

describe("validateJobId", () => {
  it("accepts a valid UUID", () => {
    expect(
      validateJobId("123e4567-e89b-41d4-a716-446655440000"),
    ).toBe("123e4567-e89b-41d4-a716-446655440000");
  });

  it("rejects malformed ids", () => {
    expect(validateJobId("not-a-uuid")).toBeInstanceOf(AppError);
    expect(validateJobId("")).toBeInstanceOf(AppError);
    expect(validateJobId("123e4567-e89b-41d4-a716-44665544000")).toBeInstanceOf(
      AppError,
    );
  });

  it("rejects non-string ids", () => {
    expect(validateJobId(42)).toBeInstanceOf(AppError);
    expect(validateJobId(null)).toBeInstanceOf(AppError);
    expect(validateJobId(undefined)).toBeInstanceOf(AppError);
  });
});
