import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { gitEnvironment } from "../src/git.ts";

const script = resolve("scripts/worktree.sh");
const config = resolve(".config/wt.toml");
const hasWorktrunk = spawnSync("wt", ["--version"], { stdio: "ignore" }).status === 0;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hunk-ado-workflow-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  for (const dir of [repo, bin, join(root, "tmp"), join(root, "home")]) await mkdir(dir);
  const env: NodeJS.ProcessEnv = {
    ...gitEnvironment(process.env), PATH: bin + delimiter + process.env.PATH,
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: join(root, "tmp"), EVENTS: join(root, "events"), REVIEW_COPY: join(root, "review.diff"),
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  delete env.WORKTRUNK_BIN;
  delete env.WORKTRUNK_DIRECTIVE_CD_FILE;
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "--initial-branch=main");
  await writeFile(join(repo, "file.txt"), "base\n");
  git("add", "."); git("commit", "-m", "base");
  git("switch", "-c", "feature");
  await writeFile(join(repo, "file.txt"), "feature\n");
  git("add", "."); git("commit", "-m", "feature");
  const executable = async (name: string, body: string) =>
    writeFile(join(bin, name), "#!/usr/bin/env bash\nset -euo pipefail\n" + body, { mode: 0o755 });
  const events = async () => (await readFile(env.EVENTS!, "utf8")).trim().split("\n");
  const run = (mode = "finish", input = "y\n", extra: NodeJS.ProcessEnv = {}) =>
    spawnSync("bash", [script, mode, "main"], { cwd: repo, env: { ...env, ...extra }, input, encoding: "utf8" });
  return { root, repo, bin, env, git, executable, events, run };
}

async function mockedWorkflow(t: TestContext) {
  const f = await fixture(t);
  await f.executable("wt", `
printf 'wt %s\\n' "$*" >> "$EVENTS"
if [[ "$1" == step && "$2" == diff ]]; then
  if [[ "\${FAIL_DIFF:-0}" == 1 ]]; then echo partial; exit 17; fi
  git diff --binary --full-index "$3"...HEAD
elif [[ "$1" == merge ]]; then
  exit 0 # Record intent only: tests never merge the user's repository.
else exit 19
fi
`);
  await f.executable("hunk", `
printf 'hunk\\n' >> "$EVENTS"
[[ "$1" == patch && -s "$2" ]]
cp -- "$2" "$REVIEW_COPY"
if [[ "\${FAIL_HUNK:-0}" == 1 ]]; then exit 18; fi
if [[ "\${CHANGE_SOURCE:-0}" == 1 ]]; then git commit --allow-empty -m changed >/dev/null; fi
if [[ "\${CHANGE_TARGET:-0}" == 1 ]]; then git update-ref refs/heads/main HEAD; fi
if [[ "\${MAKE_DIRTY:-0}" == 1 ]]; then echo edited >> file.txt; fi
`);
  return f;
}

test("finish reviews, requires confirmation, preserves exact commits and cleans its patch", async (t) => {
  const f = await mockedWorkflow(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const events = await f.events();
  assert.match(events[0]!, /^wt step diff main -- --no-ext-diff/);
  assert.equal(events[1], "hunk");
  assert.equal(events[2], "wt merge main --no-commit --no-rebase");
  assert.match(await readFile(f.env.REVIEW_COPY!, "utf8"), /\+feature/);
  assert.deepEqual(await readdir(f.env.TMPDIR!), []);
});
test("closing Hunk does not approve merging; no/EOF cancel", async (t) => {
  const f = await mockedWorkflow(t);
  for (const answer of ["n\n", "\n", ""]) {
    assert.notEqual(f.run("finish", answer).status, 0);
  }
  assert.ok(!(await f.events()).some((line) => line.startsWith("wt merge")));
  assert.deepEqual(await readdir(f.env.TMPDIR!), []);
});
test("review opens Hunk without merging, even with outstanding edits", async (t) => {
  const f = await mockedWorkflow(t);
  await writeFile(join(f.repo, "dirty.txt"), "work in progress");
  assert.equal(f.run("review", "").status, 0);
  assert.ok(!(await f.events()).some((line) => line.startsWith("wt merge")));
});
test("finish refuses dirty, target-branch and diverged checkouts before Hunk opens", async (t) => {
  const f = await mockedWorkflow(t);
  await writeFile(join(f.repo, "dirty.txt"), "dirty");
  assert.match(f.run().stderr, /outstanding changes/);
  await rm(join(f.repo, "dirty.txt"));
  f.git("switch", "main");
  assert.match(f.run().stderr, /target branch itself/);
  await writeFile(join(f.repo, "main-only.txt"), "new main change");
  f.git("add", "."); f.git("commit", "-m", "diverged");
  f.git("switch", "feature");
  assert.match(f.run().stderr, /Rebase onto main explicitly/);
  await assert.rejects(readFile(f.env.EVENTS!));
});
for (const flag of ["CHANGE_SOURCE", "CHANGE_TARGET", "MAKE_DIRTY", "FAIL_HUNK", "FAIL_DIFF"]) {
  test("finish does not merge after " + flag, async (t) => {
    const f = await mockedWorkflow(t);
    assert.notEqual(f.run("finish", "y\n", { [flag]: "1" }).status, 0);
    assert.ok(!(await f.events()).some((line) => line.startsWith("wt merge")));
    assert.deepEqual(await readdir(f.env.TMPDIR!), []);
  });
}

test("real Worktrunk diff includes committed, staged, unstaged and untracked changes without changing the index",
  { skip: !hasWorktrunk }, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.repo, "staged.txt"), "staged\n"); f.git("add", "staged.txt");
    await writeFile(join(f.repo, "file.txt"), "unstaged\n");
    await writeFile(join(f.repo, "untracked.txt"), "untracked\n");
    const before = f.git("status", "--porcelain");
    const indexBefore = f.git("diff", "--cached");
    const patch = execFileSync("wt", ["step", "diff", "main", "--", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--full-index"], {
      cwd: f.repo, env: f.env, encoding: "utf8",
    });
    for (const value of ["+staged", "+unstaged", "+untracked"]) assert.ok(patch.includes(value));
    assert.equal(f.git("status", "--porcelain"), before);
    assert.equal(f.git("diff", "--cached"), indexBefore);
  });

test("real Worktrunk merge leaves its target unchanged when pre-merge tests fail",
  { skip: !hasWorktrunk }, async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.repo, ".config"));
    await writeFile(join(f.repo, ".config/wt.toml"), await readFile(config));
    f.git("add", ".config/wt.toml"); f.git("commit", "-m", "configure hooks");
    await writeFile(join(f.root, "user.toml"), "");
    await f.executable("nix", `
printf '%s\\n' "$*" >> "$EVENTS"
if [[ "$*" == *"npm run check"* && "\${FAIL_TESTS:-0}" == 1 ]]; then exit 22; fi
`);
    const before = f.git("rev-parse", "main");
    const merge = (fail: string) => spawnSync("wt", [
      "--config", join(f.root, "user.toml"), "-y", "merge", "main",
      "--no-commit", "--no-rebase", "--no-remove",
    ], { cwd: f.repo, env: { ...f.env, FAIL_TESTS: fail }, encoding: "utf8" });
    const failed = merge("1");
    assert.notEqual(failed.status, 0);
    assert.ok((await f.events()).includes("develop --command npm run check"));
    assert.equal(f.git("rev-parse", "main"), before);
    const passed = merge("0");
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.equal(f.git("rev-parse", "main"), f.git("rev-parse", "feature"));
  });

test("Worktrunk validates aliases and runs hook dependency stages before checks",
  { skip: !hasWorktrunk }, async (t) => {
    const f = await fixture(t);
    await mkdir(join(f.repo, ".config"));
    await writeFile(join(f.repo, ".config/wt.toml"), await readFile(config));
    await writeFile(join(f.root, "user.toml"), "");
    await f.executable("nix", `
printf '%s\\n' "$*" >> "$EVENTS"
if [[ "$*" == *"npm ci"* && "\${FAIL_INSTALL:-0}" == 1 ]]; then exit 21; fi
if [[ "$*" == *"npm run check"* && "\${FAIL_TESTS:-0}" == 1 ]]; then exit 22; fi
`);
    const wt = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync("wt",
      ["--config", join(f.root, "user.toml"), ...args],
      { cwd: f.repo, env: { ...f.env, ...extra }, encoding: "utf8" });
    // --yes is used only for this disposable fixture's known hooks, never user approvals.
    assert.equal(wt(["-y", "hook", "pre-start"]).status, 0);
    assert.deepEqual(await f.events(), ["develop --command npm ci --include=dev --ignore-scripts --legacy-peer-deps"]);
    await rm(f.env.EVENTS!);
    assert.equal(wt(["-y", "hook", "pre-merge"]).status, 0);
    const events = await f.events();
    assert.match(events[0]!, /npm ci/);
    assert.deepEqual(new Set(events.slice(1)), new Set(["develop --command npm run check", "flake check"]));
    await rm(f.env.EVENTS!);
    assert.notEqual(wt(["-y", "hook", "pre-merge"], { FAIL_INSTALL: "1" }).status, 0);
    assert.equal((await f.events()).length, 1, "failed install prevents checks");
    assert.notEqual(wt(["-y", "hook", "pre-merge"], { FAIL_TESTS: "1" }).status, 0);
    const preview = wt(["config", "alias", "dry-run", "new-pi", "--", "--name=feat/test", "A prompt; not a shell command"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout + preview.stderr, /wt switch --create feat\/test --base main --execute nix/);
    assert.match(preview.stdout + preview.stderr, /pi 'A prompt; not a shell command'/);
    for (const name of ["pi", "review", "finish"]) {
      const result = wt(["config", "alias", "dry-run", name]);
      assert.equal(result.status, 0, result.stderr);
    }
  });
