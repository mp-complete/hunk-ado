# Azure DevOps PR integration for Hunk

## Conclusion

Build a **Hunk CLI extension**, not a new VCS adapter. The closest model is Hunk's bundled `hunk gh pr`: resolve a PR, prepare a patch, then delegate to Hunk's built-in `patch` command with provider-neutral PR metadata. GitLab has a standalone extension using the same design. No Hunk host modification is indicated by the documented API. [1–4]

I did **not find an existing Azure DevOps extension** in Hunk's community catalog, the GitHub topic page inspected, or targeted public searches. This is a bounded search result, not proof that none exists. [5–6]

Scope requested: Azure Repos **pull requests only**. No generic commit/comparison commands, work items, pipelines, or repository management. Whether PR integration also includes posting comments and votes remains to be decided; those are not implicitly part of the proposed first read-only slice.

This document records research and recommendations, not an implemented or tested integration.

## Existing implementations worth following

| Implementation | What it does | Relevance |
| --- | --- | --- |
| Hunk bundled `@hunk/gh` | Fetches GitHub PR metadata and raw diff, writes a restricted temporary patch, delegates to `patch`, cleans up on shutdown. Also has commit/comparison commands. | Primary template for the CLI lifecycle and transport boundaries. [2–3] |
| `modem-dev/hunk-gh` | Standalone GitHub extension with the same general fetch-and-delegate approach. | Useful historical packaging example; current Hunk source already bundles this capability. Prefer current host source for API behavior. [3,7] |
| `RubenFricke/hunk-glab` | Opens GitLab merge requests, commits, and comparisons; uses direct REST rather than requiring `glab`. | Closest standalone provider extension. Has injectable fetch/Git boundaries, dedicated parsing and patch storage, and integration tests. [4] |
| `phl28/hunk-gh-review` | Adds a PR threads pane, replies, and submission of local notes as Comment/Approve/Request changes; uses authenticated `gh`. | Useful UX reference if remote commenting becomes scope. Not a drop-in transport for ADO. [8] |

Source snapshots inspected:

- Hunk: `0cdf207e159e54cf6a0a1499615672b3a4449b98` (package version `0.25.0`).
- hunk-glab: `44173494667432f08f254ef194c55a2a60ab0572`.
- hunk-gh-review: `d1415964b0a70ad59fd4d6cfc49a958c944ffb62`.

## Hunk extension contract

- An extension default-exports a factory receiving `HunkExtensionAPI` from `hunkdiff/extension`. TypeScript source can load without a build step. Folder extensions declare entries in `package.json` under `hunk.extensions`. [1]
- `registerCliCommand({ name: "ado", ... }, handler)` can own the `hunk ado ...` command tree. Registration is synchronous during the factory; network preparation belongs in the handler. [2]
- The handler receives raw argument tokens, `cwd`, `signal`, and stdout/stderr writers. It can return `{ kind: "delegate", argv: ["patch", patchPath], review }`. Delegation must not follow stdout writes or stdin reads; progress belongs on stderr. Help can write stdout and return an exit result. [2]
- PR review metadata uses `kind: "change-request"`, with provider, title, URL, ID, repository, author, base/head, state and draft fields. Hunk validates and bounds it, including a 4 KiB total limit. Use `provider: "Azure DevOps"`; map ADO active/completed/abandoned to open/merged/closed. The state mapping is our proposed adaptation. [2,9]
- Generic CLI commands arrived in API 10; delegated patch review metadata arrived in API 17. Current inspected API is 33. Choose and test the actual supported Hunk release before declaring a minimum; another extension's API 31 declaration is not our requirement. [2]
- Patch review metadata is display/bootstrap context, not a remote provider or automatic remote-refresh contract. A refresh of a temporary patch rereads that patch; it does not fetch a newer PR automatically. [2–4]
- Use restrictive temporary directory/file permissions (0700/0600 on POSIX), retain the patch for reloads, clean it on shutdown, and handle cancellation during preparation. Shutdown is best effort, so abrupt termination can leave files behind. [2–4]
- `hunk.config` is not a trusted secret/command source: repository config can override installed-extension config. Do not take executable paths, shell commands, or arbitrary credential destinations from it. [2]

Proposed package shape:

```text
package.json          # hunk.extensions = ["./src/index.ts"]
src/index.ts          # factory, CLI registration, resource lifetime
src/cli.ts            # PR-only arguments and help
src/target.ts         # PR URL / explicit repo / origin resolution
src/ado.ts            # validated REST responses, auth, limits, cancellation
src/patch.ts          # pinned PR iteration -> complete Git patch
src/temporaryPatch.ts # retained patch and cleanup
```

This is a suggested split, not a scaffold already created.

## ADO-specific issue: obtaining the actual diff

GitHub's provider downloads a raw diff. ADO's documented `diffs/commits` endpoint returns a `GitCommitDiffs` JSON object with commit identities, a `changes` list, and `allChangesIncluded`; it is not the unified patch consumed by `hunk patch`. Its default change page size is 100. Do not assume changing the URL or Accept header gives us GitHub's raw-diff behavior. No documented raw-PR-patch endpoint was established in this investigation. [3,10]

ADO PR iterations expose `commonRefCommit`, `sourceRefCommit`, and `targetRefCommit`. The iteration changes endpoint supports comparison against the common commit (`$compareTo=0`) and pagination with `nextSkip`/`nextTop`. These provide a basis for a revision-pinned review. [11–12]

Two viable approaches need validation:

1. **Git-backed patch generation — recommended first technical spike.** Read PR metadata and the selected iteration through REST. Obtain the exact common/source commit objects and generate their diff using Git with external diff/text conversion disabled. Start in an existing checkout, verify repository identity and object availability, and never switch branches or change working-tree files. If objects are missing, explicitly fetch them or use an isolated temporary bare repository; verify the fetched identities rather than trusting moving branch names. Validate ADO fetch permissions, fork behavior, shallow history, and the relationship between iteration commits and the web PR diff. This is a proposed approach, not yet live-tested.
2. **REST-only patch assembly.** Enumerate all changes and obtain old/new blob contents at exact commits, then generate a patch. This avoids Git repository acquisition but requires a reliable implementation of path quoting, additions/deletions, renames, file modes, binary files, symlinks, submodules, encodings and final-newline semantics. Never quietly omit a page or unsupported file. GitLab's extension demonstrates reconstruction for its commit/comparison responses, but ADO's responses are different. [4,10–12]

Whichever route is chosen, pin the review to a single PR iteration, reject inconsistent/incomplete results, and handle changes during acquisition. Do not diff the user's working tree or use ADO's synthetic merge commit as though it were the PR source. Metadata documents `lastMerge*` as snapshots at the time of the last merge calculation, not unconditional current-head guarantees. [9,11]

## Proposed first slice

Proposed commands, not available yet:

```sh
hunk --extension /path/to/hunk-ado ado pr \
  'https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/123'

# Subsequent convenience form: infer repository from the checkout's origin.
hunk ado pr 123
```

Sequence:

1. Parse and validate an explicit Azure DevOps Services PR URL.
2. Authenticate and retrieve PR metadata plus an exact iteration.
3. Produce a complete patch for that iteration.
4. Delegate to Hunk with a PR header and retain the patch until shutdown.
5. Add numeric-ID/origin and current-branch discovery only after the explicit-URL path works correctly.

Recommend Azure DevOps Services (`dev.azure.com`) first. Legacy `*.visualstudio.com` URLs, SSH remote inference, and on-premises Azure DevOps Server need explicit handling rather than generic arbitrary-host credentials.

This slice only reads from ADO. Hunk's existing local review notes remain local; remote publishing is a separate capability.

## Authentication and safety

Microsoft documents obtaining an Azure DevOps Entra access token through an existing Azure CLI login using resource ID `499b84ac-1321-427f-aa17-267ca6975798`, then sending it as a Bearer token. That is a plausible fit for a corporate ADO environment. PAT-based authentication can be evaluated as an explicit alternative; the user's preferred method has not been selected. No authentication was attempted in this research. [13]

Implementation requirements:

- Validate scheme, host, organization and path components before requesting/sending credentials. Prefer constructing canonical API URLs to following response-provided URLs.
- Refuse unvalidated redirects. Treat remote Git URLs and repository-local configuration as untrusted input.
- Never place tokens in CLI arguments, logged URLs, patches or repository config. Keep credential acquisition separate from PR transport and redact errors.
- Use argument arrays, not shell interpolation. Do not silently initiate interactive sign-in from a running TUI.
- Bound metadata, patch size, acquisition time and subprocess output; propagate cancellation and handle 401/403/404/429 distinctly.
- If a Git path needs credentials too, establish how REST and Git authentication cooperate rather than assuming one implies the other.

These are proposed controls, informed by the credential-safe bounded HTTP and patch ownership in the GitHub/GitLab implementations. [2–4]

## If remote review submission is included later

Hunk supports panes, review commands, dialogs and authoritative snapshots. Prefer `ctx.review.snapshot()` to an event-only cache of notes; recapture and compare generation/stateRevision before irreversible work. The older GitHub review extension reads notes through the session CLI with an event fallback, so copy its interaction pattern rather than all of its implementation choices. [2,8]

ADO comment threads and reviewer votes are separate REST operations. A thread carries file-side positions and PR iteration context; `changeTrackingId` is required for iteration-supporting PRs. Votes use 10 (approved), 5 (approved with suggestions), 0 (none), -5 (waiting for author), and -10 (rejected). Do not promise the GitHub extension's single-call review submission semantics for ADO. Track partial success and uncertain responses, avoid duplicate retries, and preserve unsent notes. [14–15]

Before posting, verify both the Hunk review generation and the remote PR iteration still match the displayed diff. Require explicit confirmation. No comments, votes, or other remote mutations were made during this research.

## Validation before shipping

- Table-driven tests for PR URLs, encoded names, numeric IDs, malformed locators and deceptive hosts.
- Mocked transport/auth tests for cancellation, token redaction, redirects, failures and limits.
- Git fixtures for base/source divergence, renames, add/delete, binaries, file modes, no-final-newline, shallow history and unavailable commits.
- PR race tests: the source changes while metadata/objects are being acquired; never silently display an unintended revision.
- Temporary patch lifetime tests: survives reload, removed on cancellation and normal shutdown.
- Real Hunk smoke test for extension discovery, help, patch delegation and the PR header against the chosen minimum and current release.
- Read-only live ADO smoke test with a user-selected PR and authenticated environment.

Neither `hunk` nor `bun` was on the current tool shell's PATH during inspection. The repository currently has an empty README and a Nix shell with no declared build inputs; no implementation dependencies were installed and no runtime tests were run.

## Sources

1. [Hunk extension authoring and installation](https://www.hunk.dev/docs/extend/extensions/).
2. [Hunk extension API](https://www.hunk.dev/docs/extend/extension-api/); [pinned API documentation](https://github.com/modem-dev/hunk/blob/0cdf207e159e54cf6a0a1499615672b3a4449b98/website/src/content/docs/docs/extend/extension-api.md).
3. Hunk bundled GitHub provider: [CLI preparation/delegation](https://github.com/modem-dev/hunk/blob/0cdf207e159e54cf6a0a1499615672b3a4449b98/packages/hunk-gh/src/extension.ts), [HTTP transport](https://github.com/modem-dev/hunk/blob/0cdf207e159e54cf6a0a1499615672b3a4449b98/packages/hunk-gh/src/github.ts), [temporary patches](https://github.com/modem-dev/hunk/blob/0cdf207e159e54cf6a0a1499615672b3a4449b98/packages/hunk-gh/src/temporaryPatch.ts).
4. hunk-glab: [README](https://github.com/RubenFricke/hunk-glab/blob/44173494667432f08f254ef194c55a2a60ab0572/README.md), [MR preparation](https://github.com/RubenFricke/hunk-glab/blob/44173494667432f08f254ef194c55a2a60ab0572/src/prepareMergeRequest.ts), [CLI handler](https://github.com/RubenFricke/hunk-glab/blob/44173494667432f08f254ef194c55a2a60ab0572/src/createGlabCommand.ts).
5. [Hunk community directory](https://www.hunk.dev/extensions); [pinned catalog](https://github.com/modem-dev/hunk/blob/0cdf207e159e54cf6a0a1499615672b3a4449b98/website/src/data/extensions.ts).
6. [GitHub hunk-extension topic](https://github.com/topics/hunk-extension). Additional public queries: `"hunk" "extension" "Azure DevOps"` and `site:github.com "hunk-ado" OR "hunk-azure" OR "hunk" "Azure Repos"`; no relevant ADO provider surfaced.
7. [Standalone modem-dev/hunk-gh](https://github.com/modem-dev/hunk-gh).
8. hunk-gh-review: [README](https://github.com/phl28/hunk-gh-review/blob/d1415964b0a70ad59fd4d6cfc49a958c944ffb62/README.md), [implementation, especially submitReview and registration](https://github.com/phl28/hunk-gh-review/blob/d1415964b0a70ad59fd4d6cfc49a958c944ffb62/index.tsx#L551).
9. [ADO REST 7.1: Get Pull Request](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1).
10. [ADO REST 7.1: Diffs — Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/diffs/get?view=azure-devops-rest-7.1).
11. [ADO REST 7.1: Pull Request Iterations — List](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iterations/list?view=azure-devops-rest-7.1).
12. [ADO REST 7.1: Pull Request Iteration Changes — Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-iteration-changes/get?view=azure-devops-rest-7.1).
13. [Issue Entra tokens with Azure CLI](https://learn.microsoft.com/en-us/azure/devops/cli/entra-tokens?view=azure-devops).
14. [ADO REST 7.1: Pull Request Threads — Create](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-threads/create?view=azure-devops-rest-7.1).
15. [ADO REST 7.1: Pull Request Reviewers — Create / cast vote](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-reviewers/create-pull-request-reviewer?view=azure-devops-rest-7.1).
