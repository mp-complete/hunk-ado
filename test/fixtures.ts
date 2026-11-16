import { parsePrUrl } from "../src/target.ts";

export const TARGET = parsePrUrl("https://dev.azure.com/acme/My%20Project/_git/app/pullrequest/42");
export const REPO_ID = "11111111-1111-1111-1111-111111111111";
export const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
export const BASE = "a".repeat(40);
export const SOURCE = "b".repeat(40);
export const TARGET_SHA = "c".repeat(40);
export const PATCH = "diff --git a/file.txt b/file.txt\nindex 7898192..6178079 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-a\n+b\n";

export function metadata() {
  return {
    pullRequestId: 42, supportsIterations: true, isDraft: false, status: "active",
    title: "Test PR", sourceRefName: "refs/heads/feature", targetRefName: "refs/heads/main",
    createdBy: { displayName: "Ada" },
    repository: { id: REPO_ID, name: "app", project: { id: PROJECT_ID, name: "My Project" } },
  };
}
export function iterations(id = 3) {
  return { count: 1, value: [{
    id, commonRefCommit: { commitId: BASE }, sourceRefCommit: { commitId: SOURCE },
    targetRefCommit: { commitId: TARGET_SHA },
  }] };
}
export function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), init);
}
