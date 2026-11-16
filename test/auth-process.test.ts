import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireCredential } from "../src/auth.ts";
import { runProcess, type ProcessRequest } from "../src/process.ts";
const signal = () => new AbortController().signal;

test("explicit Bearer/PAT credentials need no Azure CLI and reject ambiguity", async () => {
  const noRun = async () => { throw new Error("must not execute"); };
  assert.deepEqual(await acquireCredential({ HUNK_ADO_TOKEN: "bearer" }, signal(), noRun), { authorization: "Bearer bearer" });
  assert.deepEqual(await acquireCredential({ HUNK_ADO_PAT: "pat" }, signal(), noRun), { authorization: "Basic OnBhdA==" });
  for (const env of [{ HUNK_ADO_TOKEN: "" }, { HUNK_ADO_PAT: "a\nb" }, { HUNK_ADO_PAT: " " },
    { HUNK_ADO_TOKEN: "one", HUNK_ADO_PAT: "two" }]) {
    await assert.rejects(acquireCredential(env, signal(), noRun));
  }
});
test("Azure CLI uses the ADO resource and never starts a login flow", async () => {
  let request: ProcessRequest | undefined;
  const result = await acquireCredential({}, signal(), async (r) => { request = r; return Buffer.from("token\n"); });
  assert.deepEqual(result, { authorization: "Bearer token" });
  assert.equal(request!.command, "az");
  assert.ok(request!.args.includes("499b84ac-1321-427f-aa17-267ca6975798"));
  assert.ok(!request!.args.includes("login"));
});
test("subprocess errors never expose stderr or tokens", async () => {
  await assert.rejects(runProcess({
    command: process.execPath, args: ["-e", 'console.error("secret"); process.exit(1)'],
    cwd: process.cwd(), env: {}, signal: signal(), failure: "Safe failure.",
  }), (error: Error) => error.message === "Safe failure.");
});
test("subprocess output is bounded and timeouts terminate the process", async () => {
  const request = { command: process.execPath, cwd: process.cwd(), env: {}, signal: signal(), failure: "Failed." };
  await assert.rejects(runProcess({ ...request, args: ["-e", 'console.log("x".repeat(10000))'], maxBytes: 16 }), /safety limit/);
  await assert.rejects(runProcess({ ...request, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 40 }), /timed out/);
});
test("subprocess supports preflight and in-flight cancellation", async () => {
  const controller = new AbortController();
  const request = {
    command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(), env: {}, signal: controller.signal, failure: "Failed.",
  };
  const running = runProcess(request);
  controller.abort();
  await assert.rejects(running, /cancelled/);
  await assert.rejects(runProcess(request), /cancelled/);
});
test("missing executable has an actionable, credential-safe error", async () => {
  await assert.rejects(runProcess({
    command: "hunk-ado-nonexistent-executable", args: ["secret"], cwd: process.cwd(), env: {},
    signal: signal(), failure: "Could not fetch.",
  }), /on PATH/);
});
