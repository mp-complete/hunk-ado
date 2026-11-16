import { tmpdir } from "node:os";
import type { ExtensionCliCommandHandler, ExtensionFactory } from "hunkdiff/extension";
import { AdoClient, assertSameSnapshot, reviewDescriptor } from "./ado.ts";
import { acquireCredential } from "./auth.ts";
import { UserError } from "./errors.ts";
import { buildPatch, readOrigin } from "./git.ts";
import { runProcess, type ProcessRunner } from "./process.ts";
import { HELP, parseInvocation, parsePrUrl, prId, type PullRequestTarget } from "./target.ts";
import { TemporaryPatchStore } from "./temporaryPatch.ts";

export interface Runtime {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  run: ProcessRunner;
  temporaryRoot: string;
}

export function createAdoExtension(overrides: Partial<Runtime> = {}): ExtensionFactory {
  const runtime: Runtime = {
    env: overrides.env ?? process.env, fetchImpl: overrides.fetchImpl ?? fetch,
    run: overrides.run ?? runProcess, temporaryRoot: overrides.temporaryRoot ?? tmpdir(),
  };
  const patches = new TemporaryPatchStore(runtime.temporaryRoot);
  // Hunk can overlap CLI-preprocessing and delegated-session registries.
  let registries = 0;
  return (hunk) => {
    registries++;
    let retired = false;
    const handler: ExtensionCliCommandHandler = async (args, ctx) => {
      const invocation = parseInvocation(args);
      if (invocation.help) {
        await ctx.stdout.write(HELP);
        return { kind: "exit" };
      }
      const cancelled = () => {
        if (ctx.signal.aborted) throw new UserError("ADO PR loading was cancelled.");
      };
      cancelled();
      const target: PullRequestTarget = /^[0-9]+$/.test(invocation.locator)
        ? { ...(invocation.repo ?? await readOrigin(ctx.cwd, runtime.env, ctx.signal, runtime.run)), id: prId(invocation.locator) }
        : parsePrUrl(invocation.locator);
      await ctx.stderr.write(`Loading Azure DevOps PR !${target.id}…\n`);
      const credential = await acquireCredential(runtime.env, ctx.signal, runtime.run);
      const client = new AdoClient(target, credential, runtime.fetchImpl);
      const before = await client.snapshot(ctx.signal);
      const directory = await patches.create();
      try {
        await ctx.stderr.write(`Fetching iteration ${before.iteration.id} (isolated temporary Git repository)…\n`);
        const patch = await buildPatch({
          target, snapshot: before, credential, directory, env: runtime.env,
          signal: ctx.signal, run: runtime.run,
        });
        const after = await client.snapshot(ctx.signal);
        assertSameSnapshot(before, after);
        const review = reviewDescriptor(after, target);
        cancelled();
        const path = await patches.write(directory, patch);
        await ctx.stderr.write(`Opening ${patch.byteLength.toLocaleString()} bytes in Hunk. Notes stay local.\n`);
        cancelled();
        return { kind: "delegate", argv: ["patch", path], review };
      } catch (error) {
        await patches.remove(directory);
        throw error;
      }
    };
    hunk.registerCliCommand({
      name: "ado", summary: "Review Azure DevOps pull requests",
      usage: "pr <URL|ID> [--repo <REPOSITORY-URL>]",
    }, handler);
    hunk.on("shutdown", () => {
      if (retired) return;
      retired = true;
      if (--registries === 0) patches.cleanup();
    });
  };
}

export default createAdoExtension();
