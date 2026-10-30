import { AppError, AppErrorCode } from "../errors.js";

export const ALLOWED_RUNTIMES = ["python:3.12"] as const;
export type AllowedRuntime = (typeof ALLOWED_RUNTIMES)[number];

export interface ExecutionResources {
  readonly cpu: number;
  readonly memoryMb: number;
  readonly timeoutSeconds: number;
}

export interface ExecutionSpec {
  readonly artifactId: string;
  readonly runtime: AllowedRuntime;
  readonly command: readonly string[];
  readonly workingDirectory: string;
  readonly input: Record<string, unknown>;
  readonly resources: ExecutionResources;
}

export interface ExecutionLimits {
  readonly maxCpu: number;
  readonly maxMemoryMb: number;
  readonly maxTimeoutSeconds: number;
  readonly maxCommandLength: number;
  readonly maxInputJsonBytes: number;
  readonly maxInputDepth: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxCpu: 4,
  maxMemoryMb: 1024,
  maxTimeoutSeconds: 300,
  maxCommandLength: 64,
  maxInputJsonBytes: 65536,
  maxInputDepth: 8,
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSafeRelativePath(p: string): boolean {
  if (typeof p !== "string" || p === "") return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false;
  const slash = p.replace(/\\/g, "/");
  const segments = slash.split("/");
  if (segments.some((s) => s === ".." || s === "")) return false;
  return true;
}

function measureDepth(value: unknown, limit: number): boolean {
  const seen = new WeakSet<object>();
  function visit(v: unknown, depth: number): boolean {
    if (depth > limit) return false;
    if (Array.isArray(v)) {
      if (seen.has(v)) return false;
      seen.add(v);
      for (const item of v) {
        if (!visit(item, depth + 1)) return false;
      }
      return true;
    }
    if (isPlainObject(v)) {
      if (seen.has(v)) return false;
      seen.add(v);
      for (const key of Object.keys(v)) {
        if (!visit(v[key], depth + 1)) return false;
      }
      return true;
    }
    return true;
  }
  return visit(value, 0);
}

export function validateExecutionSpec(
  value: unknown,
  limits: ExecutionLimits = DEFAULT_EXECUTION_LIMITS,
): ExecutionSpec | AppError {
  if (!isPlainObject(value)) {
    return AppError.badRequest(AppErrorCode.ValidationError, "Execution spec must be a JSON object");
  }
  const obj = value as Record<string, unknown>;

  const allowedTop = new Set([
    "artifactId",
    "runtime",
    "command",
    "workingDirectory",
    "input",
    "resources",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowedTop.has(k)) {
      return AppError.badRequest(
        AppErrorCode.ValidationError,
        `Unknown execution spec field: ${k}`,
      );
    }
  }

  if (
    typeof obj.artifactId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(obj.artifactId)
  ) {
    return AppError.badRequest(AppErrorCode.ValidationError, "artifactId must be a UUID");
  }

  if (
    typeof obj.runtime !== "string" ||
    !(ALLOWED_RUNTIMES as readonly string[]).includes(obj.runtime)
  ) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      `Unsupported runtime: ${String(obj.runtime)}`,
    );
  }

  if (!Array.isArray(obj.command) || obj.command.length === 0) {
    return AppError.badRequest(AppErrorCode.ValidationError, "command must be a non-empty array");
  }
  if (obj.command.length > limits.maxCommandLength) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      `command must not exceed ${limits.maxCommandLength} elements`,
    );
  }
  for (let i = 0; i < obj.command.length; i++) {
    if (typeof obj.command[i] !== "string" || (obj.command[i] as string) === "") {
      return AppError.badRequest(
        AppErrorCode.ValidationError,
        `command[${i}] must be a non-empty string`,
      );
    }
  }
  const command = (obj.command as string[]).slice();

  if (typeof obj.workingDirectory !== "string" || !isSafeRelativePath(obj.workingDirectory)) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      "workingDirectory must be a relative path inside the execution workspace",
    );
  }

  if (!isPlainObject(obj.input)) {
    return AppError.badRequest(AppErrorCode.ValidationError, "input must be a JSON object");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(obj.input);
  } catch {
    return AppError.badRequest(AppErrorCode.ValidationError, "input must be JSON-serializable");
  }
  if (serialized.length > limits.maxInputJsonBytes) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      `input must not exceed ${limits.maxInputJsonBytes} bytes`,
    );
  }
  if (!measureDepth(obj.input, limits.maxInputDepth)) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      `input nesting depth must not exceed ${limits.maxInputDepth}`,
    );
  }

  if (!isPlainObject(obj.resources)) {
    return AppError.badRequest(AppErrorCode.ValidationError, "resources must be a JSON object");
  }
  const r = obj.resources as Record<string, unknown>;
  const allowedRes = new Set(["cpu", "memoryMb", "timeoutSeconds"]);
  for (const k of Object.keys(r)) {
    if (!allowedRes.has(k)) {
      return AppError.badRequest(AppErrorCode.ValidationError, `Unknown resource field: ${k}`);
    }
  }
  if (typeof r.cpu !== "number" || !Number.isFinite(r.cpu) || r.cpu <= 0 || r.cpu > limits.maxCpu) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      `resources.cpu must be a positive number <= ${limits.maxCpu}`,
    );
  }
  if (
    typeof r.memoryMb !== "number" ||
    !Number.isFinite(r.memoryMb) ||
    r.memoryMb <= 0 ||
    r.memoryMb > limits.maxMemoryMb
  ) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      `resources.memoryMb must be a positive number <= ${limits.maxMemoryMb}`,
    );
  }
  if (
    typeof r.timeoutSeconds !== "number" ||
    !Number.isFinite(r.timeoutSeconds) ||
    r.timeoutSeconds <= 0 ||
    r.timeoutSeconds > limits.maxTimeoutSeconds
  ) {
    return AppError.badRequest(
      AppErrorCode.ValidationError,
      `resources.timeoutSeconds must be a positive number <= ${limits.maxTimeoutSeconds}`,
    );
  }

  return {
    artifactId: obj.artifactId as string,
    runtime: obj.runtime as AllowedRuntime,
    command,
    workingDirectory: obj.workingDirectory as string,
    input: obj.input as Record<string, unknown>,
    resources: {
      cpu: r.cpu as number,
      memoryMb: r.memoryMb as number,
      timeoutSeconds: r.timeoutSeconds as number,
    },
  };
}
