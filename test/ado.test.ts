import { test } from "node:test";
import assert from "node:assert/strict";
import { AdoClient, MAX_METADATA_BYTES, assertSameSnapshot, parseIteration, parseMetadata, reviewDescriptor } from "../src/ado.ts";
import { BASE, SOURCE, TARGET, iterations, json, metadata } from "./fixtures.ts";

const signal = () => new AbortController().signal;
const snapshot = () => ({ pr: parseMetadata(metadata(), TARGET), iteration: parseIteration(iterations()) });

test("transport uses canonical GET URLs, bounded credentials, no redirects", async () => {
  const calls: string[] = [];
  const client = new AdoClient(TARGET, { authorization: "Bearer test" }, async (input, init) => {
    const url = String(input); calls.push(url);
    assert.ok(url.startsWith("https://dev.azure.com/acme/My%20Project/_apis/git/repositories/app/pullRequests/42"));
    assert.ok(url.endsWith("?api-version=7.1"));
    assert.equal(init!.method, "GET");
    assert.equal(init!.redirect, "manual");
    assert.equal(new Headers(init!.headers).get("authorization"), "Bearer test");
    return json(url.includes("/iterations?") ? iterations() : metadata());
  });
  assert.deepEqual(await client.snapshot(signal()), snapshot());
  assert.equal(calls.length, 2);
});
for (const [status, message] of [
  [401, /rejected/], [403, /denied/], [404, /not found/], [429, /rate limited/],
  [302, /redirected/], [500, /HTTP 500/],
] as const) test("safe HTTP error " + status, async () => {
  const client = new AdoClient(TARGET, { authorization: "Bearer secret" },
    async () => new Response("do not expose secret", { status }));
  await assert.rejects(client.snapshot(signal()), (e: Error) => message.test(e.message) && !e.message.includes("secret"));
});
test("reject malformed, oversized, and incomplete metadata", async () => {
  for (const response of [
    new Response("not JSON"),
    new Response("{}", { headers: { "content-length": String(MAX_METADATA_BYTES + 1) } }),
    new Response("x".repeat(MAX_METADATA_BYTES + 1)),
    json(metadata(), { headers: { "x-ms-continuationtoken": "next" } }),
    new Response(new Uint8Array([0xff])),
  ]) {
    const client = new AdoClient(TARGET, { authorization: "Bearer test" }, async () => response);
    await assert.rejects(client.snapshot(signal()));
  }
});
test("network exceptions are redacted; timeout and cancellation are distinct", async () => {
  const client = new AdoClient(TARGET, { authorization: "Bearer secret" }, async () => { throw new Error("secret"); });
  await assert.rejects(client.snapshot(signal()), (e: Error) => !e.message.includes("secret"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.snapshot(controller.signal), /cancelled/);
  const timed = new AdoClient(TARGET, { authorization: "Bearer test" }, async (_url, init) => {
    await new Promise<void>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    });
    return json({});
  }, 20);
  // AbortSignal.timeout is unref'ed; keep the test process alive until it fires.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(timed.snapshot(signal()), /timed out/); }
  finally { clearTimeout(keepAlive); }
});
test("metadata validates identity and refuses unsupported PR shapes", () => {
  for (const data of [
    { ...metadata(), pullRequestId: 43 }, { ...metadata(), forkSource: {} },
    { ...metadata(), supportsIterations: false }, { ...metadata(), hasMultipleMergeBases: true },
    { ...metadata(), status: "unexpected" }, { ...metadata(), isDraft: "true" },
    { ...metadata(), repository: { ...metadata().repository, name: "wrong" } },
  ]) assert.throws(() => parseMetadata(data, TARGET));
});
test("latest iteration selection is numeric and refuses absent/invalid pinned commits", () => {
  const data = iterations();
  data.value.unshift({ ...data.value[0]!, id: 2 });
  data.count = 2;
  assert.equal(parseIteration(data).id, 3);
  assert.throws(() => parseIteration({ count: 0, value: [] }));
  assert.throws(() => parseIteration({ count: 2, value: iterations().value }));
  const invalid = iterations(); invalid.value[0]!.commonRefCommit.commitId = "main";
  assert.throws(() => parseIteration(invalid));
  assert.throws(() => parseIteration({ count: 2, value: [data.value[0], data.value[0]] }));
});
test("detect force-push, retarget, completion and same-ID hash races", () => {
  const before = snapshot();
  assertSameSnapshot(before, snapshot());
  for (const after of [
    { ...before, iteration: { ...before.iteration, id: 4 } },
    { ...before, iteration: { ...before.iteration, source: BASE } },
    { ...before, iteration: { ...before.iteration, base: SOURCE } },
    { ...before, pr: { ...before.pr, targetRef: "refs/heads/other" } },
    { ...before, pr: { ...before.pr, status: "completed" as const } },
  ]) assert.throws(() => assertSameSnapshot(before, after), /PR changed/);
});
test("review header fits Hunk limits, sanitizes controls and maps status", () => {
  const data = snapshot();
  data.pr.title = "\u001b[31m" + "漢".repeat(3000);
  const descriptor = reviewDescriptor(data, TARGET);
  assert.equal(descriptor.provider, "Azure DevOps");
  assert.equal(descriptor.base, "main");
  assert.equal(descriptor.head, "feature");
  assert.equal(descriptor.state, "open");
  assert.ok(!descriptor.title.includes("\u001b"));
  assert.ok(Buffer.byteLength(descriptor.title) <= 512);
  assert.ok(Buffer.byteLength(JSON.stringify(descriptor)) <= 4096);
  assert.equal(reviewDescriptor({ ...data, pr: { ...data.pr, status: "completed" } }, TARGET).state, "merged");
  assert.equal(reviewDescriptor({ ...data, pr: { ...data.pr, status: "abandoned" } }, TARGET).state, "closed");
});
