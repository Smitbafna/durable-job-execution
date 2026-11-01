import { describe, it, expect } from "vitest";
import { AppError, AppErrorCode } from "../errors.js";
import {
  FailureClassification,
  classifyFailure,
} from "../domain/failureClassification.js";

describe("failure classification", () => {
  it("nonzero user-program exit is non-retryable", () => {
    expect(
      classifyFailure({ exitCode: 1, stdout: "", stderr: "boom", durationMs: 1 }),
    ).toBe(FailureClassification.NonRetryable);
  });

  it("invalid execution spec is non-retryable", () => {
    expect(
      classifyFailure(
        new AppError(AppErrorCode.ValidationError, 400, "bad spec"),
      ),
    ).toBe(FailureClassification.NonRetryable);
  });

  it("invalid ZIP is non-retryable", () => {
    expect(
      classifyFailure(
        new AppError(AppErrorCode.ValidationError, 400, "Invalid ZIP archive"),
      ),
    ).toBe(FailureClassification.NonRetryable);
  });

  it("missing artifact is non-retryable", () => {
    expect(
      classifyFailure(new AppError(AppErrorCode.NotFound, 404, "Artifact not found")),
    ).toBe(FailureClassification.NonRetryable);
  });

  it("timeout is non-retryable", () => {
    expect(
      classifyFailure({
        exitCode: 124,
        stdout: "",
        stderr: "execution timed out",
        durationMs: 1,
      }),
    ).toBe(FailureClassification.NonRetryable);
  });

  it("Docker daemon unavailable is retryable", () => {
    expect(
      classifyFailure(
        new AppError(
          AppErrorCode.Internal,
          500,
          "Docker execution failed: Cannot connect to the Docker daemon",
          { retryable: true, failureKind: "docker_infrastructure" },
        ),
      ),
    ).toBe(FailureClassification.Retryable);
  });

  it("recognized temporary Docker infrastructure failure is retryable", () => {
    expect(
      classifyFailure(
        new AppError(
          AppErrorCode.Internal,
          500,
          "Docker execution failed: temporary failure",
          { retryable: true, failureKind: "docker_infrastructure" },
        ),
      ),
    ).toBe(FailureClassification.Retryable);
  });

  it("unknown error defaults to non-retryable", () => {
    expect(classifyFailure(new Error("something weird"))).toBe(
      FailureClassification.NonRetryable,
    );
    expect(classifyFailure("nope")).toBe(FailureClassification.NonRetryable);
  });

  it("ownership loss does not become a retryable execution failure", () => {
    expect(
      classifyFailure(
        new AppError(AppErrorCode.Conflict, 409, "ownership lost for job"),
      ),
    ).toBe(FailureClassification.NonRetryable);
  });

  it("classification preserves the original useful error details", () => {
    const err = new AppError(AppErrorCode.Internal, 500, "Docker execution failed: temporary", {
      retryable: true,
      failureKind: "docker_infrastructure",
      nested: { value: 42 },
    });
    const before = JSON.stringify(err.details);
    classifyFailure(err);
    expect(JSON.stringify(err.details)).toBe(before);
  });
});