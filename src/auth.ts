import { tmpdir } from "node:os";
import { UserError } from "./errors.ts";
import { runProcess, type ProcessRunner } from "./process.ts";

export interface Credential { authorization: string }

function token(value: string): string {
  if (!value || value.length > 32768 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new UserError("The configured ADO credential is empty or contains invalid characters.");
  }
  return value;
}

/** Acquisition is explicit environment input or a pre-existing Azure CLI login, never a login prompt. */
export async function acquireCredential(
  env: NodeJS.ProcessEnv, signal: AbortSignal, run: ProcessRunner = runProcess,
): Promise<Credential> {
  if (signal.aborted) throw new UserError("ADO PR loading was cancelled.");
  if (env.HUNK_ADO_TOKEN !== undefined && env.HUNK_ADO_PAT !== undefined) {
    throw new UserError("Set only one of HUNK_ADO_TOKEN and HUNK_ADO_PAT.");
  }
  if (env.HUNK_ADO_TOKEN !== undefined) return { authorization: `Bearer ${token(env.HUNK_ADO_TOKEN)}` };
  if (env.HUNK_ADO_PAT !== undefined) {
    return { authorization: `Basic ${Buffer.from(":" + token(env.HUNK_ADO_PAT)).toString("base64")}` };
  }
  const result = await run({
    command: "az",
    args: ["account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798",
      "--query", "accessToken", "--output", "tsv", "--only-show-errors"],
    cwd: tmpdir(), env, signal, maxBytes: 32768, timeoutMs: 30_000,
    failure: "Could not obtain an Azure DevOps token. Run az login for your ADO tenant, or set HUNK_ADO_TOKEN / HUNK_ADO_PAT.",
  });
  return { authorization: `Bearer ${token(result.toString("utf8").trim())}` };
}
