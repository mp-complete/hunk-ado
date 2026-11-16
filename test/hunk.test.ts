import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("real Hunk discovers the folder extension and runs help without credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hunk-ado-host-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = resolve("node_modules/hunkdiff/bin/hunk.cjs");
  const env: NodeJS.ProcessEnv = {
    ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
    HUNK_ADO_TOKEN: "", HUNK_ADO_PAT: "",
  };
  delete env.HUNK_BIN_PATH; // Exercise the locked devDependency, not a local override.
  const output = execFileSync(process.execPath, [cli, "--extension", resolve("."), "ado", "--help"], {
    cwd: root, env, timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /hunk ado pr/);
  assert.match(output, /Notes stay local/);
  const invalid = spawnSync(process.execPath, [cli, "--extension", resolve("."), "ado", "commit", "abc"], {
    cwd: root, env, timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Use hunk ado pr/);
});
