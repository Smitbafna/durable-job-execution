import { describe, it, expect } from "vitest";
import {
  SUPPORTED_JOB_TYPES,
  isSupportedJobType,
  describeJobType,
  validateSumNumbersPayload,
  JOB_TYPES,
  MAX_NUMBERS,
} from "../domain/jobTypes.js";
import { AppError, AppErrorCode } from "../errors.js";

describe("job types", () => {
  it("supports exactly sum_numbers in Week 1", () => {
    expect(SUPPORTED_JOB_TYPES).toEqual(["sum_numbers"]);
  });

  it("isSupportedJobType accepts supported and rejects unknown", () => {
    expect(isSupportedJobType("sum_numbers")).toBe(true);
    expect(isSupportedJobType("bogus")).toBe(false);
    expect(isSupportedJobType("")).toBe(false);
    expect(isSupportedJobType(123)).toBe(false);
    expect(isSupportedJobType(null)).toBe(false);
    expect(isSupportedJobType(undefined)).toBe(false);
  });

  it("describeJobType returns the definition for a known type", () => {
    const def = describeJobType("sum_numbers");
    expect(def.type).toBe("sum_numbers");
    expect(def.resultShape).toBe("{ sum: number } — the arithmetic sum of `payload.numbers`");
  });

  it("describeJobType throws for an unknown type", () => {
    expect(() => describeJobType("bogus")).toThrow(AppError);
    try {
      describeJobType("bogus");
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe(AppErrorCode.UnsupportedJobType);
      expect(err.statusCode).toBe(400);
    }
  });

  it("documents the expected result shape for sum_numbers", () => {
    // The result shape is the contract the future worker must produce.
    expect(JOB_TYPES.sum_numbers.resultShape).toBe(
      "{ sum: number } — the arithmetic sum of `payload.numbers`",
    );
    // Compile-time: SumNumbersResult is structurally { sum: number }.
    const _check: import("../domain/jobTypes.js").SumNumbersResult = { sum: 42 };
    expect(_check.sum).toBe(42);
  });
});

describe("sum_numbers payload validation", () => {
  it("accepts an array of numbers", () => {
    expect(validateSumNumbersPayload({ numbers: [1, 2, 3] })).toEqual({
      numbers: [1, 2, 3],
    });
  });

  it("accepts edge-case numbers and empty arrays", () => {
    expect(validateSumNumbersPayload({ numbers: [] })).toEqual({ numbers: [] });
    expect(validateSumNumbersPayload({ numbers: [0, -0, 1.5, -7, 1e6] })).toEqual({
      numbers: [0, -0, 1.5, -7, 1e6],
    });
  });

  it("returns a defensive copy (does not mutate/reuse input)", () => {
    const input = { numbers: [1, 2, 3] };
    const result = validateSumNumbersPayload(input) as { numbers: number[] };
    expect(result).not.toBe(input);
    result.numbers.push(4);
    expect(input.numbers).toEqual([1, 2, 3]);
  });

  it("rejects missing numbers", () => {
    const err = validateSumNumbersPayload({});
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(AppErrorCode.ValidationError);
  });

  it("rejects numbers that is not an array", () => {
    const err = validateSumNumbersPayload({ numbers: "1,2,3" });
    expect(err).toBeInstanceOf(AppError);
  });

  it("rejects non-finite numbers", () => {
    expect(validateSumNumbersPayload({ numbers: [NaN] })).toBeInstanceOf(AppError);
    expect(validateSumNumbersPayload({ numbers: [Infinity] })).toBeInstanceOf(AppError);
    expect(validateSumNumbersPayload({ numbers: ["1"] })).toBeInstanceOf(AppError);
  });
  it("rejects payloads exceeding the max number count", () => {
    const tooLong = { numbers: new Array(MAX_NUMBERS + 1).fill(1) } as {
      numbers: number[];
    };
    const err = validateSumNumbersPayload(tooLong);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(AppErrorCode.ValidationError);
  });

  it("rejects non-object payloads", () => {
    expect(validateSumNumbersPayload(null)).toBeInstanceOf(AppError);
    expect(validateSumNumbersPayload("string")).toBeInstanceOf(AppError);
    expect(validateSumNumbersPayload([1, 2, 3])).toBeInstanceOf(AppError);
  });
});
