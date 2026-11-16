import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInvocation, parsePrUrl, parseRepositoryUrl, prId, pullRequestUrl } from "../src/target.ts";

test("PR URL decoding and canonical re-encoding preserve names", () => {
  const target = parsePrUrl("https://dev.azure.com/acme/My%20Project/_git/repo%20name/pullrequest/42?_a=files#discussion");
  assert.deepEqual(target, { organization: "acme", project: "My Project", repository: "repo name", id: 42 });
  assert.equal(pullRequestUrl(target), "https://dev.azure.com/acme/My%20Project/_git/repo%20name/pullrequest/42");
});
test("HTTPS origin may contain a username, never a password", () => {
  assert.equal(parseRepositoryUrl("https://acme@dev.azure.com/acme/project/_git/repo", true).organization, "acme");
  assert.throws(() => parseRepositoryUrl("https://u:secret@dev.azure.com/acme/project/_git/repo", true));
  assert.throws(() => parseRepositoryUrl("git@ssh.dev.azure.com:v3/acme/project/repo", true));
});
for (const url of [
  "http://dev.azure.com/acme/p/_git/r/pullrequest/1",
  "https://dev.azure.com.evil.test/acme/p/_git/r/pullrequest/1",
  "https://dev.azure.com:443/acme/p/_git/r/pullrequest/1",
  "https://dev.azure.com:8443/acme/p/_git/r/pullrequest/1",
  "https://dev.azure.com./acme/p/_git/r/pullrequest/1",
  "https://user@dev.azure.com/acme/p/_git/r/pullrequest/1",
  "https://dev.azure.com/acme/../p/_git/r/pullrequest/1",
  "https://dev.azure.com/acme/%2e%2e/_git/r/pullrequest/1",
  "https://dev.azure.com/acme/p/_git/r%2Fx/pullrequest/1",
  "https://dev.azure.com/acme/p/_git/r%5Cx/pullrequest/1",
  "https://dev.azure.com/acme/p/_git/%00/pullrequest/1",
  "https://dev.azure.com/acme/p/_git/%1b/pullrequest/1",
  "https://dev.azure.com/acme/p/_git/%ZZ/pullrequest/1",
  "https://dev.azure.com/acme/p/_git/r/pullrequest/0",
  "https://dev.azure.com/acme/p/_git/r/pullrequest/2147483648",
  "https://dev.azure.com/acme/p/_git/r/pullrequest/1/extra",
  "https://dev.azure.com/acme/p/_git/r/pullrequest/1\\anything",
]) test("reject unsafe locator: " + JSON.stringify(url), () => assert.throws(() => parsePrUrl(url)));

test("CLI has only PR and help commands, with explicit repo for numeric IDs", () => {
  assert.deepEqual(parseInvocation([]), { help: true });
  assert.deepEqual(parseInvocation(["pr", "--help"]), { help: true });
  assert.deepEqual(parseInvocation(["pr", "42"]), { help: false, locator: "42" });
  assert.equal(parseInvocation(["pr", "42", "--repo", "https://dev.azure.com/acme/p/_git/r"]).help, false);
  for (const args of [
    ["commit", "abc"], ["pr"], ["pr", "-1"], ["pr", "0"], ["pr", "01"],
    ["pr", "42", "--token", "secret"], ["pr", "42", "--", "--no-extensions"],
    ["pr", "https://dev.azure.com/acme/p/_git/r/pullrequest/1", "--repo", "https://dev.azure.com/acme/p/_git/r"],
  ]) assert.throws(() => parseInvocation(args));
  assert.throws(() => prId("1.2"));
});
