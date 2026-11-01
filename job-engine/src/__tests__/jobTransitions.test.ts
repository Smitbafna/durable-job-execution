import { describe, it, expect } from "vitest";
import { JobStatus } from "../domain/job.js";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  assertTransitionAllowed,
} from "../domain/jobTransitions.js";
import { AppError, AppErrorCode } from "../errors.js";

describe("job state transitions", () => {
  it("allows queued -> running and queued -> cancelled", () => {
    expect(canTransition(JobStatus.Queued, JobStatus.Running)).toBe(true);
    expect(canTransition(JobStatus.Queued, JobStatus.Cancelled)).toBe(true);
  });

  it("allows running -> succeeded and running -> failed", () => {
    expect(canTransition(JobStatus.Running, JobStatus.Succeeded)).toBe(true);
    expect(canTransition(JobStatus.Running, JobStatus.Failed)).toBe(true);
  });

  it("allows retry from succeeded/failed -> running", () => {
    expect(canTransition(JobStatus.Succeeded, JobStatus.Running)).toBe(true);
    expect(canTransition(JobStatus.Failed, JobStatus.Running)).toBe(true);
  });

  it("disallows transitions out of terminal states incorrectly", () => {
    expect(canTransition(JobStatus.Cancelled, JobStatus.Running)).toBe(false);
    expect(canTransition(JobStatus.Succeeded, JobStatus.Queued)).toBe(false);
    expect(canTransition(JobStatus.Failed, JobStatus.Queued)).toBe(false);
  });

  it("disallows running -> queued and running -> cancelled", () => {
    expect(canTransition(JobStatus.Running, JobStatus.Queued)).toBe(false);
    expect(canTransition(JobStatus.Running, JobStatus.Succeeded)).toBe(true);
    expect(canTransition(JobStatus.Running, JobStatus.Failed)).toBe(true);
  });

  it("disallows queued -> succeeded/failed (job must run first)", () => {
    expect(canTransition(JobStatus.Queued, JobStatus.Succeeded)).toBe(false);
    expect(canTransition(JobStatus.Queued, JobStatus.Failed)).toBe(false);
  });

  it("assertTransitionAllowed throws for disallowed transitions", () => {
    expect(() =>
      assertTransitionAllowed(JobStatus.Succeeded, JobStatus.Queued),
    ).toThrow(AppError);
  });

  it("assertTransitionAllowed does not throw for allowed transitions", () => {
    expect(() =>
      assertTransitionAllowed(JobStatus.Queued, JobStatus.Running),
    ).not.toThrow();
  });

  it("the thrown error is a 409 conflict describing the transition", () => {
    let caught: AppError | undefined;
    try {
      assertTransitionAllowed(JobStatus.Succeeded, JobStatus.Queued);
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught?.statusCode).toBe(409);
    expect(caught?.code).toBe(AppErrorCode.ValidationError);
    expect(caught?.details).toEqual({
      from: "succeeded",
      to: "queued",
      allowed: ["running"],
    });
  });

  it("documents the complete transition graph", () => {
    // The graph is fully known; assert the documented expectations so any
    // accidental change is caught. `running -> cancelled` is the only new
    // terminal transition added by the cancellation work.
    expect(ALLOWED_TRANSITIONS).toEqual({
      queued: ["running", "cancelled"],
      running: ["succeeded", "failed", "cancelled"],
      succeeded: ["running"],
      failed: ["running"],
      cancelled: [],
    });
  });
});
