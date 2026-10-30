/** Job Engine — worker handler registry.
 *
 * Maps job types to their handlers. The worker dispatches every claimed job to
 * the registered handler for its type; unknown types are rejected explicitly
 * and persisted as `failed` rather than left in an ambiguous state.
 *
 * Week 2 only ships the `sum_numbers` handler. Adding a new job type is a
 * matter of:
 *   1. declare its payload/result types in `domain/jobTypes.ts`,
 *   2. add a handler module in `src/worker/handlers/`,
 *   3. register it here.
 */

import type { JobHandler, JobResult, JobType } from "../../domain/jobTypes.js";
import { sumNumbersHandler } from "./sumNumbersHandler.js";

/** The handler that executes a validated payload for a given job type. */
/** The complete set of job types that this engine can execute. */
export const HANDLER_REGISTRY: Readonly<Record<JobType, JobHandler>> = {
  sum_numbers: sumNumbersHandler({}),
};

/** Returns the handler for a job type, or `undefined` when unsupported. */
export function lookupHandler(type: string): JobHandler | undefined {
  return HANDLER_REGISTRY[type as JobType];
}
