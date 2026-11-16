import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCliCommandHandler, HunkExtensionAPI } from "hunkdiff/extension";
import { createAdoExtension, type Runtime } from "../src/index.ts";
import { PATCH, iterations, json, metadata } from "./fixtures.ts";

async function setup(overrides: Partial<Runtime> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hunk-ado-extension-test-"));
  const shutdowns: (() => void)[] = [];
  let handler: ExtensionCliCommandHandler;
  const runtime: Runtime = {
    temporaryRoot: root, env: { HUNK_ADO_TOKEN: "test-token" },
    fetchImpl: async (url) => json(String(url).includes("/iterations?") ? iterations() : metadata()),
    run: async ({ args }) => Buffer.from(args.includes("diff") ? PATCH : args.includes("cat-file") ? "commit" : ""),
    ...overrides,
  };
  const factory = createAdoExtension(runtime);
  const register = async () => {
    await factory({
      registerCliCommand: (command: { name: string }, callback: ExtensionCliCommandHandler) => {
        assert.equal(command.name, "ado"); handler = callback;
      },
      on: (event: string, callback: () => void) => { assert.equal(event, "shutdown"); shutdowns.push(callback); },
    } as unknown as HunkExtensionAPI);
  };
  await register();
  let stdout = "", stderr = "";
  const controller = new AbortController();
  const ctx = {
    cwd: root, signal: controller.signal,
    stdin: { async *[Symbol.asyncIterator]() { throw new Error("must not consume stdin"); } },
    stdout: { async write(value: string | Uint8Array) { stdout += value; } },
    stderr: { async write(value: string | Uint8Array) { stderr += value; } },
  };
  return {
    root, factory, register, shutdowns, ctx, controller,
    output: () => ({ stdout, stderr }),
    call: async (args: string[]) => handler!(args, ctx),
    cleanup: async () => { shutdowns.forEach((f) => f()); await rm(root, { recursive: true, force: true }); },
  };
}
const ARGS = ["pr", "https://dev.azure.com/acme/My%20Project/_git/app/pullrequest/42"];

test("delegates once to patch with metadata; survives overlapping registries and cleans on final shutdown", async (t) => {
  const harness = await setup(); t.after(harness.cleanup);
  const result = await harness.call(ARGS);
  assert.equal(result.kind, "delegate");
  if (result.kind !== "delegate") return;
  assert.equal(result.argv[0], "patch");
  assert.equal(await readFile(result.argv[1]!, "utf8"), PATCH);
  assert.equal(result.review!.provider, "Azure DevOps");
  assert.equal(harness.output().stdout, "");
  assert.match(harness.output().stderr, /Notes stay local/);
  await harness.register(); // delegated registry overlaps preprocessor ownership
  harness.shutdowns[0]!();
  harness.shutdowns[0]!(); // repeated shutdown is harmless
  assert.equal(await readFile(result.argv[1]!, "utf8"), PATCH);
  harness.shutdowns[1]!();
  await assert.rejects(stat(result.argv[1]!));
  assert.deepEqual(await readdir(harness.root), []);
});
test("help is network/auth-free and exits without delegation", async (t) => {
  const harness = await setup({
    env: {}, run: async () => { throw new Error("must not execute"); },
    fetchImpl: async () => { throw new Error("must not fetch"); },
  }); t.after(harness.cleanup);
  assert.deepEqual(await harness.call(["--help"]), { kind: "exit" });
  assert.match(harness.output().stdout, /hunk ado pr/);
  assert.deepEqual(await readdir(harness.root), []);
});
test("PR changes during acquisition fail closed and remove the patch workspace", async (t) => {
  let iterationsRead = 0;
  const harness = await setup({ fetchImpl: async (url) => json(
    String(url).includes("/iterations?") ? iterations(++iterationsRead === 1 ? 3 : 4) : metadata(),
  ) }); t.after(harness.cleanup);
  await assert.rejects(harness.call(ARGS), /PR changed/);
  assert.deepEqual(await readdir(harness.root), []);
});
test("Git failure and cancellation before delegation remove all temporary files", async (t) => {
  const failed = await setup({ run: async () => { throw new Error("Git unavailable"); } }); t.after(failed.cleanup);
  await assert.rejects(failed.call(ARGS), /Git unavailable/);
  assert.deepEqual(await readdir(failed.root), []);
  const cancelled = await setup(); t.after(cancelled.cleanup);
  cancelled.ctx.stderr.write = async (message) => {
    if (String(message).includes("Opening")) cancelled.controller.abort();
  };
  await assert.rejects(cancelled.call(ARGS), /cancelled/);
  assert.deepEqual(await readdir(cancelled.root), []);
});
test("numeric PR with explicit repository does not inspect the current checkout", async (t) => {
  const harness = await setup({ run: async ({ args }) => {
    assert.ok(!args.includes("--local"));
    return Buffer.from(args.includes("diff") ? PATCH : args.includes("cat-file") ? "commit" : "");
  } }); t.after(harness.cleanup);
  assert.equal((await harness.call(["pr", "42", "--repo", "https://dev.azure.com/acme/My%20Project/_git/app"])).kind, "delegate");
});
