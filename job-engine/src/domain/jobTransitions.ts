/**
 * Job Engine — state-transition rules.
 *
 * This file is the **single source of truth** for which status transitions are
 * permitted. `canTransition` / `assertTransitionAllowed` are the only entry
 * points used to enforce it.
 *
 * Week 1 (this milestone) only ever produces `queued` jobs — there is no worker
 * to advance them. The remaining transitions are defined now so the worker /
 * scheduler added in Week 2 reuses the exact same rules without redefining them:
 *
 *   queued     -> running, cancelled   (`running` needs a worker; `cancelled` needs a cancel API)
 *   running    -> succeeded, failed
 *   succeeded  -> running               (retry of a terminal-success job; Week 2)
 *   failed     -> running               (retry; Week 2)
 *   cancelled  -> (terminal — no outgoing transitions)
 */

import { AppError, AppErrorCode } from "../errors.js";
import { JobStatus } from "./job.js";

export const ALLOWED_TRANSITIONS: Readonly<
  Record<JobStatus, readonly JobStatus[]>
> = {
  [JobStatus.Queued]: [JobStatus.Running, JobStatus.Cancelled],
  [JobStatus.Running]: [JobStatus.Succeeded, JobStatus.Failed, JobStatus.Cancelled],
  [JobStatus.Succeeded]: [JobStatus.Running],
  [JobStatus.Failed]: [JobStatus.Running],
  [JobStatus.Cancelled]: [],
} as const;

/** Returns true iff a transition from `from` to `to` is permitted. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/** Throws an `AppError` (409 Conflict) when the transition is not permitted. */
export function assertTransitionAllowed(
  from: JobStatus,
  to: JobStatus,
): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      AppErrorCode.ValidationError,
      409,
      `Invalid job status transition: ${from} -> ${to}`,
      { from, to, allowed: ALLOWED_TRANSITIONS[from] ?? [] },
    );
  }
}
