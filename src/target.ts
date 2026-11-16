import { UserError } from "./errors.ts";

export interface Repository {
  organization: string;
  project: string;
  repository: string;
}
export interface PullRequestTarget extends Repository { id: number }

const BAD_TEXT = /[\u0000-\u0020\u007f-\u009f\\]/u;
const BAD_COMPONENT = /[\u0000-\u001f\u007f-\u009f/\\?#]/u;

function component(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new UserError("The ADO URL contains an invalid escape sequence."); }
  if (!decoded || decoded === "." || decoded === ".." ||
      BAD_COMPONENT.test(decoded) || Buffer.byteLength(decoded) > 255) {
    throw new UserError("The ADO URL contains an invalid path component.");
  }
  return decoded;
}

export function prId(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 2_147_483_647) {
    throw new UserError("A PR ID must be a positive 32-bit integer.");
  }
  return Number(value);
}

/** Parse the raw path before WHATWG URL normalization can hide dot segments/backslashes. */
function parseUrl(input: string, origin: boolean): { repo: Repository; rest: string[] } {
  if (BAD_TEXT.test(input) || input.length > 2000) throw new UserError("Invalid ADO URL.");
  const match = /^https:\/\/([^/?#]+)(\/[^?#]*)(?:[?#].*)?$/i.exec(input);
  if (!match) throw new UserError("Use an HTTPS dev.azure.com URL.");
  let url: URL;
  try { url = new URL(input); } catch { throw new UserError("Invalid ADO URL."); }
  if (url.hostname !== "dev.azure.com" || url.port || url.password ||
      (!origin && url.username) || (origin && /:/.test(match[1]!))) {
    throw new UserError("Only dev.azure.com HTTPS URLs without ports or passwords are supported.");
  }
  // Reject even an explicitly specified default port, which URL.port normalizes away.
  const authority = match[1]!.split("@").at(-1)!;
  if (authority.toLowerCase() !== "dev.azure.com") throw new UserError("Unsupported ADO host.");
  const parts = match[2]!.replace(/\/$/, "").split("/").slice(1).map(component);
  if (parts.length < 4 || parts[2] !== "_git" ||
      !/^[a-z0-9][a-z0-9-]{0,49}$/i.test(parts[0]!)) {
    throw new UserError("Expected https://dev.azure.com/ORG/PROJECT/_git/REPO.");
  }
  const repo = { organization: parts[0]!, project: parts[1]!, repository: parts[3]! };
  if (repositoryUrl(repo).length > 1700) throw new UserError("The ADO repository URL is too long.");
  return { repo, rest: parts.slice(4) };
}

export function parsePrUrl(input: string): PullRequestTarget {
  const { repo, rest } = parseUrl(input, false);
  if (rest.length !== 2 || rest[0]!.toLowerCase() !== "pullrequest") {
    throw new UserError("Expected an ADO pull request URL ending in /pullrequest/123.");
  }
  return { ...repo, id: prId(rest[1]!) };
}

export function parseRepositoryUrl(input: string, origin = false): Repository {
  const { repo, rest } = parseUrl(input, origin);
  if (rest.length) throw new UserError("Expected a repository URL, not a PR or API URL.");
  return repo;
}

export function repositoryUrl(repo: Repository): string {
  return `https://dev.azure.com/${encodeURIComponent(repo.organization)}/${encodeURIComponent(repo.project)}/_git/${encodeURIComponent(repo.repository)}`;
}

export function pullRequestUrl(target: PullRequestTarget): string {
  return `${repositoryUrl(target)}/pullrequest/${target.id}`;
}

export const HELP = `Open an Azure DevOps pull request in Hunk (read-only).

Usage:
  hunk ado pr <PR-URL>
  hunk ado pr <ID> [--repo <REPOSITORY-URL>]

Examples:
  hunk ado pr https://dev.azure.com/org/project/_git/repo/pullrequest/123
  hunk ado pr 123
  hunk ado pr 123 --repo https://dev.azure.com/org/project/_git/repo

Numeric IDs infer an HTTPS origin unless --repo is provided.
Authentication: HUNK_ADO_TOKEN (Bearer), HUNK_ADO_PAT, or an existing az login.
Only Azure DevOps Services, same-repository PRs with iterations are supported.
Git fetches exact commits into a temporary bare repository; your checkout is untouched.
Notes stay local. No comments, votes, or other ADO writes are performed.
`;

export type Invocation = { help: true } | { help: false; locator: string; repo?: Repository };

export function parseInvocation(args: readonly string[]): Invocation {
  if (!args.length || (args.length === 1 && ["--help", "-h"].includes(args[0]!)) ||
      (args.length === 2 && args[0] === "pr" && ["--help", "-h"].includes(args[1]!))) {
    return { help: true };
  }
  if (args[0] !== "pr" || !args[1] || ![2, 4].includes(args.length)) {
    throw new UserError("Use hunk ado pr <PR-URL|ID>. Run hunk ado --help for usage.");
  }
  const locator = args[1];
  const repo = args.length === 4 && args[2] === "--repo" ? parseRepositoryUrl(args[3]!) : undefined;
  if (args.length === 4 && !repo) throw new UserError("Unknown option. Only --repo is supported.");
  if (/^[0-9]+$/.test(locator)) prId(locator);
  else {
    parsePrUrl(locator);
    if (repo) throw new UserError("--repo cannot be combined with a PR URL.");
  }
  return { help: false, locator, ...(repo ? { repo } : {}) };
}
