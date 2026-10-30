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
import { toZipLimits } from "../zip/zipValidation.js";
import type { ArtifactConfig } from "../config.js";
import { AppError, AppErrorCode } from "../errors.js";

const execFileAsync = promisify(execFile);

export class DockerRuntime implements ExecutionRuntime {
  constructor(
    private readonly artifactConfig: ArtifactConfig,
    private readonly dockerConfig: DockerConfig,
    private readonly executionLimits: { maxInputJsonBytes: number; maxInputDepth: number } = {
      maxInputJsonBytes: 65536,
      maxInputDepth: 8,
    },
  ) {}

  async execute(spec: ExecutionSpec, artifactPath: string): Promise<ExecutionResult> {
    const started = Date.now();
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "job-engine-workspace-"));
    const stagedZip = path.join(workspace, "artifact.zip");
    const extractDir = path.join(workspace, "project");
    const containerName = `job-engine-${randomUUID()}`;
    try {
      await fs.copyFile(artifactPath, stagedZip);
      const limits = toZipLimits(this.artifactConfig);
      const zipBuffer = await fs.readFile(stagedZip);
      await extractZipToWorkspace(zipBuffer, extractDir, limits);

      const workdirRelative = spec.workingDirectory === "." ? "" : spec.workingDirectory;
      const containerWorkdir = workdirRelative
        ? `/workspace/${workdirRelative.replace(/^\/+/, "")}`
        : "/workspace";
      const hostWorkdir = path.resolve(extractDir, workdirRelative || ".");
      const extractRoot = path.resolve(extractDir);
      if (hostWorkdir !== extractRoot && !hostWorkdir.startsWith(extractRoot + path.sep)) {
        throw new AppError(AppErrorCode.ValidationError, 400, "Invalid working directory");
      }
      try {
        await fs.access(hostWorkdir);
      } catch {
        throw new AppError(AppErrorCode.ValidationError, 400, "Working directory does not exist");
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
        this.dockerConfig.image,
        ...spec.command,
      ];

      const result = await this.runContainer(args, containerName, spec.resources.timeoutSeconds, this.dockerConfig.maxOutputBytes);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      // Best-effort cleanup of container.
      await execFileAsync("docker", ["rm", "-f", containerName]).catch(() => undefined);
      if (err instanceof AppError) throw err;
      throw new AppError(AppErrorCode.Internal, 500, `Docker execution failed: ${(err as Error).message}`);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runContainer(
    args: string[],
    containerName: string,
    timeoutSeconds: number,
    maxOutputBytes: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        execFileAsync("docker", ["kill", containerName]).catch(() => undefined);
        child.kill("SIGKILL");
      }, timeoutSeconds * 1000);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < maxOutputBytes) {
          const remaining = maxOutputBytes - stdout.length;
          if (chunk.length <= remaining) {
            stdout += chunk.toString("utf8");
          } else {
            stdout += chunk.subarray(0, remaining).toString("utf8");
            stdoutTruncated = true;
          }
        } else {
          stdoutTruncated = true;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < maxOutputBytes) {
          const remaining = maxOutputBytes - stderr.length;
          if (chunk.length <= remaining) {
            stderr += chunk.toString("utf8");
          } else {
            stderr += chunk.subarray(0, remaining).toString("utf8");
            stderrTruncated = true;
          }
        } else {
          stderrTruncated = true;
        }
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (timedOut) {
          resolve({
            exitCode: 124,
            stdout: stdout + (stdoutTruncated ? "\n[output truncated]" : ""),
            stderr: (stderr + (stderrTruncated ? "\n[output truncated]" : "")) + "\nexecution timed out",
          });
          return;
        }
        resolve({
          exitCode: code ?? 1,
          stdout: stdout + (stdoutTruncated ? "\n[output truncated]" : ""),
          stderr: stderr + (stderrTruncated ? "\n[output truncated]" : ""),
        });
      });
    });
  }
}
