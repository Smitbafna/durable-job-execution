/**
 * Job Engine — unit tests for the worker handler registry and the
 * `sum_numbers` handler.
 *
 * These exercise the handler *contract* without a database: payload validation
 * is reused from the existing domain layer, the result is exactly
 * `{ sum: number }`, and unsupported types produce no handler.
 */

import { describe, it, expect } from "vitest";
import { sumNumbersHandler } from "../../src/worker/handlers/sumNumbersHandler.js";
import {
  lookupHandler,
  HANDLER_REGISTRY,
} from "../../src/worker/handlers/registry.js";
import { describeJobType } from "../../src/domain/jobTypes.js";
import { AppError, AppErrorCode } from "../../src/errors.js";

describe("worker handler registry", () => {
  it("registers exactly one handler (sum_numbers)", () => {
    expect(HANDLER_REGISTRY).toHaveProperty("sum_numbers");
    expect(Object.keys(HANDLER_REGISTRY)).toEqual(["sum_numbers"]);
  });

  it("lookupHandler returns the handler for sum_numbers", () => {
    const handler = lookupHandler("sum_numbers");
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("function");
  });

  it("lookupHandler returns undefined for an unknown type", () => {
    expect(lookupHandler("no_such_type")).toBeUndefined();
  });

  it("lookupHandler rejects non-string types at runtime safety (never throws on undefined key)", () => {
    // The index access is guarded by the runtime `Record` + `as JobType`; we
    // simply assert the function does not throw here (undefined is returned).
    const handler = lookupHandler(undefined as unknown as string);
    expect(handler).toBeUndefined();
  });
});

describe("sum_numbers handler", () => {
  it("computes the sum of a list of numbers", () => {
    const handler = sumNumbersHandler({});
    const result = handler({ numbers: [1, 2, 3] });
    expect(result).toEqual({ sum: 6 });
  });

  it("handles an empty array (sum is 0)", () => {
    const handler = sumNumbersHandler({});
    expect(handler({ numbers: [] })).toEqual({ sum: 0 });
  });

  it("handles negative and floating-point numbers", () => {
    const handler = sumNumbersHandler({});
    expect(handler({ numbers: [1.5, -2, 3.25] })).toEqual({ sum: 2.75 });
  });

  it("reuses the existing domain validation (rejects invalid payloads)", () => {
    const handler = sumNumbersHandler({});
    const invalidPayloads: unknown[] = [
      null,
      "not an object",
      { numbers: "1,2,3" } as unknown,
      { numbers: [1, NaN] },
      { numbers: [1, Infinity] },
    ];
    for (const payload of invalidPayloads) {
      expect(() => handler(payload)).toThrow(AppError);
      try {
        handler(payload);
      } catch (e) {
        const err = e as AppError;
        expect(err.code).toBe(AppErrorCode.ValidationError);
      }
    }
  });

  it("produces a result matching the declared result shape", () => {
    const handler = sumNumbersHandler({});
    const result = handler({ numbers: [1, 2, 3] });
    // Compile-time + runtime structural check.
    const _check: import("../domain/jobTypes.js").SumNumbersResult = result as import("../domain/jobTypes.js").SumNumbersResult;
    expect(_check).toHaveProperty("sum");
    expect(typeof _check.sum).toBe("number");
  });
});
