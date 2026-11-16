# hunk-ado

Open an Azure DevOps pull request in [Hunk](https://www.hunk.dev), without checking out its branch or changing your working tree.

This is a **read-only PR integration**. It displays the diff and PR metadata. Hunk review notes remain local; the extension does not post comments, cast votes, create PRs, or change anything in ADO.

## Run with Nix

No npm install or global Hunk configuration is needed:

```sh
nix run . -- ado --help
nix run . -- ado pr 'https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/123'
```

The flake uses the locked nixpkgs Hunk **0.25.0** and bundles this extension, Git, and Azure CLI. It provides:

- `nix run .` / `nix run .#hunk-ado`: Hunk with the extension preloaded from an immutable source snapshot.
- `nix build`: the same wrapper at `result/bin/hunk`.
- `nix build .#extension`: just the extension at `result/share/hunk/extensions/hunk-ado`.
- `nix develop`: Node.js 24/npm, Git, Azure CLI, and a `hunk` wrapper that loads the **live checkout** when entered from this repo. Edits take effect on the next Hunk invocation.
- `nix flake check`: verifies the packaged Hunk can load the extension and run its help.

```sh
nix develop
hunk ado --help
hunk ado pr 'https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/123'
```

The shell records the checkout in `HUNK_ADO_EXTENSION_PATH`, so you can `cd` to an ADO checkout and run `hunk ado pr 123`. Entering the shell outside this repo falls back to the packaged extension. Existing `.envrc`/direnv integration uses the same shell.

Nix Git flakes include tracked files only. When adding new source files, make them visible to Git (`git add -N path/to/file` is sufficient) before building. The extension source fileset excludes `node_modules`, `.direnv`, tests, and unrelated checkout files.

No Hunk user config is edited or extension installed globally by the flake. As with other Hunk extensions, running the wrapper authorizes executing this extension with your user permissions.

## Authenticate

### Existing Azure CLI login (default)

Sign in to the tenant associated with your ADO organization, outside Hunk:

```sh
nix develop
az login --tenant YOUR_TENANT_ID
hunk ado pr 'https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/123'
```

The extension calls `az account get-access-token` for the Azure DevOps resource (`499b84ac-1321-427f-aa17-267ca6975798`). It never starts an interactive login flow. Your identity must have read access to the project and repository.

### Explicit token

Alternatively, set **one** of these in your environment through your normal secret-management mechanism:

| Variable | Authentication |
| --- | --- |
| `HUNK_ADO_TOKEN` | Entra access token for the Azure DevOps resource; sent as Bearer |
| `HUNK_ADO_PAT` | Azure DevOps PAT with **Code (Read)** and repository access; sent as Basic |

Explicit variables take precedence over Azure CLI; setting both is an error. Empty/invalid tokens are errors, not a reason to silently fall back. Do not put credentials in command-line arguments, Hunk config, this repo, or the Nix flake: Nix store contents are readable by other local users.

The same credential is used for REST and Git, so a separate Git credential helper is not required. Git receives a URL-scoped authorization header through its process environment, not argv or a saved config file. Same-user/privileged process inspection can still read process environments; this is not a secret-isolation boundary.

## Commands

```sh
# Works from any directory; no existing clone required.
hunk ado pr 'https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/123'

# Infer the repository from the current checkout's HTTPS origin.
hunk ado pr 123

# Explicit repository when using a numeric ID.
hunk ado pr 123 --repo 'https://dev.azure.com/ORG/PROJECT/_git/REPO'

hunk ado --help
```

URL-encode spaces and other special characters in project/repository names. Browser PR URLs with query strings/fragments are accepted; those extras are discarded. HTTPS origin URLs with an organization username (`https://ORG@dev.azure.com/...`) are accepted for inference, but embedded passwords are rejected.

The command requires an explicit PR ID or URL. It does not discover a PR from your branch, list PRs, or accept arbitrary patch flags. Configure Hunk's appearance through its normal settings.

## Use without Nix

Requirements: **Hunk 0.25.0+ (extension API 33)**, Git with `--no-write-fetch-head` support (Git 2.29+), and Azure CLI unless you supply a token. No extension runtime npm dependencies or build step are needed.

```sh
hunk --extension /absolute/path/to/hunk-ado ado --help
hunk --extension /absolute/path/to/hunk-ado ado pr 'https://dev.azure.com/ORG/PROJECT/_git/REPO/pullrequest/123'
```

For persistent loading, add the checkout to your own `~/.config/hunk/config.toml`:

```toml
[extensions]
paths = ["/absolute/path/to/hunk-ado"]
```

Once the project is in a committed Git checkout, Hunk's managed installer also supports `hunk extension install /absolute/path/to/hunk-ado`. Avoid loading another copy at the same time as the Nix wrapper. Nothing has been published to npm or installed globally by this project.

## What happens

1. Validate a `dev.azure.com` target and obtain credentials.
2. Read PR metadata and select its latest iteration, pinning the common, source, and target commit IDs.
3. Create an isolated temporary bare Git repository. Shallow-fetch the exact common/source commit objects over HTTPS—never the synthetic PR merge ref or your working tree.
4. Generate a full Git patch, including renames, file modes, deletions, binary patches, submodule entries and final-newline markers. External diff programs and text conversion are disabled.
5. Re-read PR metadata/iterations. Refuse the review if its revision, branches, repository, or state changed during acquisition.
6. Remove the temporary Git objects, retain the patch, and delegate to Hunk's built-in patch viewer with PR title, author, branches, state and URL.

The displayed patch is an immutable snapshot. Hunk reloads reread it, **not** a newer PR iteration. Rerun the command to refresh from ADO. There is no ongoing remote watch or remote-note synchronization.

### Limits and safety

- Azure DevOps Services **`dev.azure.com` only**. Legacy `visualstudio.com` URLs, SSH origin inference, Azure DevOps Server, forks, legacy PRs without iteration support, and multiple merge bases are not supported in v1. Use a canonical HTTPS PR URL when your clone has an SSH origin.
- Requests refuse redirects and only use canonical URLs on the selected ADO host. Repository configuration cannot supply executables or credential destinations.
- REST metadata is limited to 2 MiB per response, patches to 64 MiB. Metadata/token acquisition has a 30-second timeout, Git fetch 180 seconds, and diff generation 60 seconds.
- Fetching two shallow commits still downloads their full file trees. Large repos can use substantial bandwidth and temporary disk space; the patch-size limit is **not** a download/disk quota. There is no persistent cache.
- Expired/inaccessible historical objects cause an error rather than falling back to moving branch tips.
- Temporary directories/patches use POSIX modes 0700/0600. Windows uses inherited temporary-directory ACLs. Normal shutdown and preparation failures remove temporary files; a crash or force-kill can leave `hunk-ado-*` directories in the system temp directory. Remove only directories belonging to sessions you have closed.
- Local Git configuration and inherited Git routing/config variables are ignored for acquisition. Nonstandard proxies, custom credential helpers, private CAs, and corporate Git-specific settings may need separate integration; TLS verification is never disabled.
- Validated on Linux/WSL. Other platforms and live tenant-specific ADO behavior still need verification.

## Development and validation

```sh
nix develop
npm ci --ignore-scripts --legacy-peer-deps
npm run check
nix flake check
```

`npm run check` runs TypeScript checking plus the Node test suite. Tests cover URL/auth validation, mocked ADO transport and races, subprocess cancellation/limits, real Git patch generation/applicability, temporary cleanup, Hunk registration/delegation, and real Hunk CLI discovery. They do **not** contact ADO or use your credentials. The npm Hunk version is pinned to 0.25.0 for compatibility checks.

An optional offline TUI fixture exercises the actual Hunk viewer with a small synthetic PR:

```sh
# Use the unwrapped npm Hunk here, not the Nix wrapper (both register "ado").
./node_modules/.bin/hunk --extension "$PWD/test/smoke-extension.ts" ado pr \
  'https://dev.azure.com/acme/My%20Project/_git/app/pullrequest/42'
```

The fixture injects fake REST/Git results and fake credentials. Press `q` to close it. A real ADO PR smoke test is still needed to verify your tenant's authorization and exact-commit fetch policy.

Architecture research and upstream references: [`docs/research/hunk-ado-extension.md`](docs/research/hunk-ado-extension.md).
