import { devNull } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { Credential } from "./auth.ts";
import { commitId, type PrSnapshot } from "./ado.ts";
import { UserError } from "./errors.ts";
import { runProcess, type ProcessRunner } from "./process.ts";
import { parseRepositoryUrl, repositoryUrl, type Repository, type PullRequestTarget } from "./target.ts";

export const MAX_PATCH_BYTES = 64 * 1024 * 1024;

/** Ignore inherited Git routing/config/credentials; do not let the reviewed checkout redirect execution. */
export function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith("GIT_") && !["HUNK_ADO_TOKEN", "HUNK_ADO_PAT", "AZURE_DEVOPS_EXT_PAT"].includes(key),
  ));
  return {
    ...clean, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
  };
}

export async function readOrigin(
  cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, run: ProcessRunner = runProcess,
): Promise<Repository> {
  const result = await run({
    command: "git", args: ["config", "--local", "--get", "remote.origin.url"],
    cwd, env: gitEnvironment(env), signal, maxBytes: 8192,
    failure: "Could not read origin. Pass a full PR URL or --repo https://dev.azure.com/ORG/PROJECT/_git/REPO.",
  });
  return parseRepositoryUrl(result.toString("utf8").trim(), true);
}

export interface BuildPatchOptions {
  target: PullRequestTarget;
  snapshot: PrSnapshot;
  credential: Credential;
  directory: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  run?: ProcessRunner;
}

/** Fetch two exact trees, never a moving branch or the synthetic PR merge ref. */
export async function buildPatch(options: BuildPatchOptions): Promise<Buffer> {
  const { snapshot, credential, directory, signal } = options;
  const run = options.run ?? runProcess;
  const base = commitId(snapshot.iteration.base);
  const source = commitId(snapshot.iteration.source);
  if (base === source) throw new UserError("This PR iteration has no changes.");
  const url = repositoryUrl({
    ...options.target, project: snapshot.pr.projectId, repository: snapshot.pr.repositoryId,
  });
  parseRepositoryUrl(url); // Validate again before attaching any Git credential.
  const env = gitEnvironment(options.env);
  const config: [string, string][] = [
    ["credential.helper", ""],
    ["http.followRedirects", "false"],
    ["http.sslVerify", "true"],
    ["http." + url + ".extraHeader", "Authorization: " + credential.authorization],
    ["core.hooksPath", join(directory, "empty-hooks")],
    ["core.attributesFile", devNull],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["fetch.fsckObjects", "true"],
  ];
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], i) => {
    env["GIT_CONFIG_KEY_" + i] = key;
    env["GIT_CONFIG_VALUE_" + i] = value;
  });
  const repository = join(directory, "objects.git");
  const invoke = (args: string[], failure: string, maxBytes = 1024 * 1024, timeoutMs = 30_000) =>
    run({ command: "git", args, cwd: directory, env, signal, failure, maxBytes, timeoutMs });
  try {
    await invoke(["init", "--bare", "--template=", repository], "Could not create the temporary Git repository.");
    await invoke([
      "--git-dir", repository, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules",
      "--no-write-fetch-head", "--depth=1", "--", url, base, source,
    ], "Could not fetch the exact PR commits. Check repository read permission, network access, and whether the commits still exist.", 1024 * 1024, 180_000);
    // Peel commit objects explicitly. A malformed server must not substitute trees or tags.
    for (const sha of [base, source]) {
      const type = await invoke(["--git-dir", repository, "cat-file", "-t", sha], "Could not verify a pinned PR commit.");
      if (type.toString().trim() !== "commit") throw new UserError("The PR revision is not a Git commit.");
    }
    const patch = await invoke([
      "--git-dir", repository, "-c", "diff.algorithm=myers", "-c", "diff.renames=true",
      "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative",
      "--binary", "--full-index", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/",
      "--submodule=short", "--ignore-submodules=none", "--unified=3", base, source, "--",
    ], "Could not generate the PR patch (maximum 64 MiB).", MAX_PATCH_BYTES, 60_000);
    if (!patch.length) throw new UserError("This PR iteration has no file changes.");
    return patch;
  } finally {
    // Drop fetched source trees before handing the patch to Hunk.
    await rm(repository, { recursive: true, force: true });
  }
}
