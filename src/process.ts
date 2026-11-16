import { spawn } from "node:child_process";
import { UserError } from "./errors.ts";

export interface ProcessRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  failure: string;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Never exposes subprocess output or arguments in an error (they can contain credentials). */
export function runProcess(request: ProcessRequest): Promise<Buffer> {
  const { signal, failure } = request;
  if (signal.aborted) return Promise.reject(new UserError("ADO PR loading was cancelled."));
  return new Promise((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd, env: request.env, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let problem: Error | undefined;
    let size = 0;
    let stderrSize = 0;
    const chunks: Buffer[] = [];
    const stop = (error: Error) => {
      problem ??= error;
      // Kill the process group too: Git can own an HTTPS transport process.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The process may already have exited. */ }
    };
    const cancel = () => stop(new UserError("ADO PR loading was cancelled."));
    const timer = setTimeout(
      () => stop(new UserError(failure + " Operation timed out.")),
      request.timeoutMs ?? 30_000,
    );
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => {
      if (problem) return;
      size += chunk.length;
      if (size > (request.maxBytes ?? 1024 * 1024)) {
        stop(new UserError(failure + " Output exceeded the safety limit."));
      } else chunks.push(chunk);
    });
    // Drain, but never retain or print stderr.
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 1024 * 1024) stop(new UserError(failure + " Excessive error output."));
    });
    child.on("error", () => { problem ??= new UserError(failure + " Check the required executable is on PATH."); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      if (problem) reject(problem);
      else if (code !== 0) reject(new UserError(failure));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export type ProcessRunner = typeof runProcess;
