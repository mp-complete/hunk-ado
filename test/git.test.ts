import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, rm, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPatch, gitEnvironment, readOrigin } from "../src/git.ts";
import { runProcess, type ProcessRunner } from "../src/process.ts";
import { TemporaryPatchStore } from "../src/temporaryPatch.ts";
import { parseIteration, parseMetadata } from "../src/ado.ts";
import { TARGET, iterations, metadata } from "./fixtures.ts";

test("isolated Git generates complete pinned diffs and leaves the checkout unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hunk-ado-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout"); await mkdir(checkout);
  const env = {
    ...gitEnvironment(process.env), GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  git("init", "--initial-branch=main");
  await writeFile(join(checkout, "rename me.txt"), "unchanged content for a pure rename\n");
  await writeFile(join(checkout, "remove.txt"), "delete me\n");
  await writeFile(join(checkout, "no-newline.txt"), "old");
  await writeFile(join(checkout, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(join(checkout, "script.sh"), "#!/bin/sh\necho hello\n");
  git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(checkout, "target-only.txt"), "not part of this PR\n");
  git("add", "."); git("commit", "-m", "target diverged");
  const target = git("rev-parse", "HEAD");
  git("checkout", "-b", "feature", base);
  git("mv", "rename me.txt", "renamed file.txt");
  git("rm", "remove.txt");
  await writeFile(join(checkout, "no-newline.txt"), "new");
  await writeFile(join(checkout, "binary.bin"), Buffer.from([0, 4, 5, 6]));
  await writeFile(join(checkout, "added.txt"), "added\n");
  await chmod(join(checkout, "script.sh"), 0o755);
  if (process.platform !== "win32") await symlink("added.txt", join(checkout, "link"));
  git("add", "."); git("commit", "-m", "source");
  const source = git("rev-parse", "HEAD");
  await writeFile(join(checkout, "dirty.txt"), "must remain untouched");
  const status = git("status", "--porcelain");
  // A repo-local external diff would execute if we accidentally reviewed the working checkout.
  git("config", "diff.external", "must-never-run-hunk-ado-test");
  const snapshot = { pr: parseMetadata(metadata(), TARGET), iteration: { id: 3, base, source, target } };
  const store = new TemporaryPatchStore(root);
  const directory = await store.create();
  const secret = "test-credential";
  let sawFetch = false;
  const run: ProcessRunner = async (request) => {
    assert.ok(!JSON.stringify(request.args).includes(secret), "token is never a process argument");
    assert.equal(request.env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "\\\\.\\nul" : "/dev/null");
    if (request.args.includes("fetch")) {
      sawFetch = true;
      assert.ok(request.args.includes("--depth=1"));
      assert.deepEqual(request.args.slice(-2), [base, source]);
      const url = request.args.at(-3)!;
      assert.match(url, /^https:\/\/dev\.azure\.com\/acme\//);
      assert.equal(request.env.HUNK_ADO_TOKEN, undefined);
      assert.ok(Object.values(request.env).includes("Authorization: Bearer " + secret));
      assert.ok(Object.values(request.env).includes("http." + url + ".extraHeader"));
      // The test replaces only the network source. Production never enables the file protocol.
      const args = [...request.args]; args[args.length - 3] = "file://" + checkout;
      const count = Number(request.env.GIT_CONFIG_COUNT);
      return runProcess({ ...request, args, env: {
        ...request.env, GIT_CONFIG_COUNT: String(count + 1),
        ["GIT_CONFIG_KEY_" + count]: "protocol.file.allow", ["GIT_CONFIG_VALUE_" + count]: "always",
      } });
    }
    return runProcess(request);
  };
  const patch = await buildPatch({
    target: TARGET, snapshot, credential: { authorization: "Bearer " + secret }, directory,
    env: { ...process.env, HUNK_ADO_TOKEN: secret, GIT_DIR: "/malicious", GIT_EXTERNAL_DIFF: "must-not-run" },
    signal: new AbortController().signal, run,
  });
  assert.equal(sawFetch, true);
  const text = patch.toString();
  assert.match(text, /rename from rename me.txt/);
  assert.match(text, /rename to renamed file.txt/);
  assert.match(text, /GIT binary patch/);
  assert.match(text, /old mode 100644\nnew mode 100755/);
  assert.match(text, /No newline at end of file/);
  assert.match(text, /deleted file mode/);
  assert.match(text, /new file mode/);
  assert.ok(!text.includes("target-only.txt"));
  assert.equal(git("rev-parse", "HEAD"), source);
  assert.equal(git("status", "--porcelain"), status);
  assert.equal(await readFile(join(checkout, "dirty.txt"), "utf8"), "must remain untouched");
  await assert.rejects(stat(join(directory, "objects.git")));
  const path = await store.write(directory, patch);
  // Git can apply the full binary patch to the pinned base, not merely parse its text.
  const validation = join(root, "validation");
  execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", checkout, validation], { env, stdio: "pipe" });
  execFileSync("git", ["checkout", "--detach", base], { cwd: validation, env, stdio: "pipe" });
  execFileSync("git", ["apply", "--check", path], { cwd: validation, env, stdio: "pipe" });
  store.cleanup();
  await assert.rejects(stat(directory));
});

test("numeric IDs resolve only local origin, without inherited Git overrides", async () => {
  const origin = await readOrigin("/checkout", { GIT_DIR: "wrong", HUNK_ADO_PAT: "secret" },
    new AbortController().signal, async (request) => {
      assert.deepEqual(request.args, ["config", "--local", "--get", "remote.origin.url"]);
      assert.equal(request.env.GIT_DIR, undefined);
      assert.equal(request.env.HUNK_ADO_PAT, undefined);
      return Buffer.from("https://acme@dev.azure.com/acme/My%20Project/_git/app\n");
    });
  assert.deepEqual(origin, { organization: "acme", project: "My Project", repository: "app" });
});

test("temporary storage uses restrictive modes, exclusive writes and complete cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hunk-ado-store-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TemporaryPatchStore(root);
  const directory = await store.create();
  const path = await store.write(directory, Buffer.from("patch"));
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  assert.equal(await readFile(path, "utf8"), "patch");
  await assert.rejects(store.write(directory, Buffer.from("overwrite")));
  await store.remove("/not-owned"); // never remove paths not created by this store
  assert.equal(await readFile(path, "utf8"), "patch");
  await store.remove(directory);
  store.cleanup();
  assert.deepEqual(await readdir(root), []);
});

test("failed object acquisition removes scratch repository; equal revisions are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hunk-ado-failed-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "objects.git"));
  const snapshot = { pr: parseMetadata(metadata(), TARGET), iteration: parseIteration(iterations()) };
  await assert.rejects(buildPatch({
    target: TARGET, snapshot, credential: { authorization: "Bearer test" },
    directory: root, env: {}, signal: new AbortController().signal,
    run: async () => { throw new Error("failed"); },
  }), /failed/);
  await assert.rejects(stat(join(root, "objects.git")));
  snapshot.iteration.source = snapshot.iteration.base;
  await assert.rejects(buildPatch({
    target: TARGET, snapshot, credential: { authorization: "Bearer test" },
    directory: root, env: {}, signal: new AbortController().signal,
  }), /no changes/);
});
