/** sum_numbers — { numbers: number[] } -> { sum: number }.
 *
 * Reuses the existing domain payload validator instead of duplicating logic, so
 * a claim whose payload no longer validates on a worker is persisted as a
 * `failed` job instead of being dropped or double-executed.
 */
import { describeJobType } from "../../domain/jobTypes.js";
import { AppError } from "../../errors.js";
import type { JobHandler, SumNumbersResult } from "../../domain/jobTypes.js";

export interface SumNumbersHandlerOptions {}

export function sumNumbersHandler(
  _options: SumNumbersHandlerOptions,
): JobHandler {
  return (payload: unknown): SumNumbersResult => {
    const validated = describeJobType("sum_numbers").validatePayload(payload);
    if (validated instanceof AppError) {
      // Surface validation problems to the worker so they become failed jobs
      // instead of silently dropping the job.
      throw validated;
    }

    const numbers = (validated as { numbers: number[] }).numbers;
    const sum = numbers.reduce((acc, n) => acc + n, 0);
    return { sum };
  };
}
