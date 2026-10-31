import type { ExecutionSpec } from "../domain/executionSpec.js";

export interface ExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface ExecutionRuntime {
  execute(
    spec: ExecutionSpec,
    artifactPath: string,
    options?: { signal?: AbortSignal },
  ): Promise<ExecutionResult>;
}

/**
 * A non-production runtime used for orchestration tests and milestone M2.
 * It does NOT execute shell commands, evaluate uploaded code, or launch Docker.
 */
export class PlaceholderRuntime implements ExecutionRuntime {
  async execute(
    _spec: ExecutionSpec,
    _artifactPath: string,
    _options?: { signal?: AbortSignal },
  ): Promise<ExecutionResult> {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "placeholder runtime: no execution performed",
      durationMs: 0,
    };
  }
}

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, ExecutionRuntime>();

  register(id: string, runtime: ExecutionRuntime): void {
    this.runtimes.set(id, runtime);
  }

  resolve(id: string): ExecutionRuntime | undefined {
    return this.runtimes.get(id);
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        const maybeShutdown = (runtime as { shutdown?: () => Promise<void> }).shutdown;
        if (typeof maybeShutdown === "function") {
          await maybeShutdown.call(runtime);
        }
      }),
    );
  }
}
