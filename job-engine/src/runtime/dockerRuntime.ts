import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { ExecutionRuntime, ExecutionResult } from "./executionRuntime.js";
import type { ExecutionSpec } from "../domain/executionSpec.js";
import type { DockerConfig } from "../config.js";
import { extractZipToWorkspace } from "../zip/zipExtractor.js";
import { toZipLimits } from "./../zip/zipValidation.js";
import type { ArtifactConfig } from "../config.js";
import { AppError, AppErrorCode } from "../errors.js";

const execFileAsync = promisify(execFile);
const DOCKER_IMAGE = "python:3.12";
const TRUNCATION_MARKER = "\n[output truncated]";

export class DockerRuntime implements ExecutionRuntime {
  private readonly activeContainers = new Set<string>();

  constructor(
    private readonly artifactConfig: ArtifactConfig,
    private readonly dockerConfig: DockerConfig,
  ) {}

  async execute(
    spec: ExecutionSpec,
    artifactPath: string,
    options?: { signal?: AbortSignal },
  ): Promise<ExecutionResult> {
    const started = Date.now();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "job-engine-workspace-"));
    const stagedZip = path.join(workspace, "artifact.zip");
    const extractDir = path.join(workspace, "project");
    const containerName = `job-engine-${randomUUID()}`;
    this.activeContainers.add(containerName);
    let aborted = false;
    const abortHandler = () => {
      aborted = true;
      void execFileAsync("docker", ["kill", containerName]).catch(() => undefined);
      void execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
    };
    options?.signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      if (options?.signal?.aborted) {
        aborted = true;
        throw new Error("execution cancelled");
      }
      await fs.copyFile(artifactPath, stagedZip);
      const limits = toZipLimits(this.artifactConfig);
      const zipBuffer = await fs.readFile(stagedZip);
      await extractZipToWorkspace(zipBuffer, extractDir, limits, options?.signal);
      if (aborted || options?.signal?.aborted) {
        throw new Error("execution cancelled");
      }

      const workdirRelative = spec.workingDirectory === "." ? "" : spec.workingDirectory;
      const containerWorkdir = workdirRelative
        ? `/workspace/${workdirRelative.replace(/^\/+/, "")}`
        : "/workspace";
      const hostWorkdir = path.resolve(extractDir, workdirRelative || ".");
      const extractRoot = path.resolve(extractDir);
      if (hostWorkdir !== extractRoot && !hostWorkdir.startsWith(extractRoot + path.sep)) {
        throw new AppError(AppErrorCode.ValidationError, 400, "Invalid working directory");
      }
      let stat;
      try {
        stat = await fs.stat(hostWorkdir);
      } catch {
        throw new AppError(AppErrorCode.ValidationError, 400, "Working directory does not exist");
      }
      if (!stat.isDirectory()) {
        throw new AppError(AppErrorCode.ValidationError, 400, "Working directory is not a directory");
      }

      const args = [
        "run",
        "--rm",
        "--name",
        containerName,
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        `/tmp:rw,noexec,nosuid,size=${this.dockerConfig.tmpfsSizeMb}m`,
        "--user",
        "1000:1000",
        "--cpus",
        String(spec.resources.cpu),
        "--memory",
        `${spec.resources.memoryMb}m`,
        "--memory-swap",
        `${spec.resources.memoryMb}m`,
        "--pids-limit",
        String(this.dockerConfig.pidLimit),
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "-v",
        `${extractDir}:/workspace:ro`,
        "-w",
        containerWorkdir,
        "-e",
        "PYTHONDONTWRITEBYTECODE=1",
        DOCKER_IMAGE,
        ...spec.command,
      ];

      if (aborted || options?.signal?.aborted) {
        throw new Error("execution cancelled");
      }
      const result = await this.runContainer(args, containerName, spec.resources.timeoutSeconds, this.dockerConfig.maxOutputBytes, options?.signal);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      options?.signal?.removeEventListener("abort", abortHandler);
      await execFileAsync("docker", ["rm", "-f", containerName]).catch((e) => {
        console.error("[docker-runtime] cleanup failed", { containerName, error: (e as Error).message });
      });
      if (err instanceof AppError) throw err;
      throw new AppError(AppErrorCode.Internal, 500, `Docker execution failed: ${(err as Error).message}`);
    } finally {
      options?.signal?.removeEventListener("abort", abortHandler);
      this.activeContainers.delete(containerName);
      await fs.rm(workspace, { recursive: true, force: true }).catch((e) => {
        console.error("[docker-runtime] workspace cleanup failed", { workspace, error: (e as Error).message });
      });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.activeContainers].map(async (name) => {
        await execFileAsync("docker", ["kill", name]).catch((e) => {
          console.error("[docker-runtime] kill failed", { containerName: name, error: (e as Error).message });
        });
        await execFileAsync("docker", ["rm", "-f", name]).catch((e) => {
          console.error("[docker-runtime] cleanup failed", { containerName: name, error: (e as Error).message });
        });
      }),
    );
    this.activeContainers.clear();
  }

  private async runContainer(
    args: string[],
    containerName: string,
    timeoutSeconds: number,
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let aborted = false;
      let abortCleanup: Promise<void> | null = null;
      const abortHandler = () => {
        if (settled) return;
        aborted = true;
        abortCleanup = (async () => {
          await execFileAsync("docker", ["kill", containerName]).catch(() => undefined);
          await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
        })();
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let totalBytes = 0;
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        execFileAsync("docker", ["kill", containerName]).catch((e) => {
          console.error("[docker-runtime] kill failed", { containerName, error: (e as Error).message });
        });
        child.kill("SIGKILL");
      }, timeoutSeconds * 1000);

      const append = (chunks: Buffer[], current: number, chunk: Buffer): number => {
        const remaining = maxOutputBytes - totalBytes;
        if (remaining <= 0) {
          truncated = true;
          return current;
        }
        const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        chunks.push(slice);
        totalBytes += slice.length;
        if (chunk.length > remaining) {
          truncated = true;
        }
        return current + slice.length;
      };

      // Abort handling already registered before spawn; nothing to add here.

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes = append(stdoutChunks, stdoutBytes, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes = append(stderrChunks, stderrBytes, chunk);
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", async (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortHandler);
        if (aborted && abortCleanup) {
          await abortCleanup;
        }
        if (aborted) {
          reject(new Error("execution cancelled"));
          return;
        }
        let stdout = Buffer.concat(stdoutChunks).toString("utf8");
        let stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (truncated) {
          // Append marker only if budget remains; otherwise replace tail.
          if (stdout.length + TRUNCATION_MARKER.length <= maxOutputBytes) {
            stdout += TRUNCATION_MARKER;
          }
          if (stderr.length + TRUNCATION_MARKER.length <= maxOutputBytes) {
            stderr += TRUNCATION_MARKER;
          }
        }
        if (timedOut) {
          resolve({ exitCode: 124, stdout, stderr: `${stderr}\nexecution timed out` });
          return;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}
