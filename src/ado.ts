import type { ExtensionChangeRequestReviewDescriptor } from "hunkdiff/extension";
import type { Credential } from "./auth.ts";
import { UserError } from "./errors.ts";
import { parsePrUrl, pullRequestUrl, type PullRequestTarget } from "./target.ts";

export const MAX_METADATA_BYTES = 2 * 1024 * 1024;
export interface PrMetadata {
  id: number;
  repositoryId: string;
  projectId: string;
  repositoryName: string;
  projectName: string;
  title: string;
  author: string;
  sourceRef: string;
  targetRef: string;
  status: "active" | "completed" | "abandoned";
  draft: boolean;
}
export interface Iteration { id: number; base: string; source: string; target: string }
export interface PrSnapshot { pr: PrMetadata; iteration: Iteration }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UserError("Azure DevOps returned malformed PR metadata.");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 8192) {
    throw new UserError("Azure DevOps returned an invalid metadata field.");
  }
  return value;
}
function integer(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
    throw new UserError("Azure DevOps returned an invalid PR or iteration ID.");
  }
  return Number(value);
}
function guid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new UserError("Azure DevOps returned an invalid repository or project ID.");
  }
  return value.toLowerCase();
}
export function commitId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new UserError("Azure DevOps did not provide an exact Git commit for this iteration.");
  }
  return value.toLowerCase();
}

export function parseMetadata(value: unknown, target: PullRequestTarget): PrMetadata {
  const data = object(value);
  if (integer(data.pullRequestId) !== target.id) throw new UserError("Azure DevOps returned a different PR.");
  if (data.forkSource) throw new UserError("Fork pull requests are not supported in this version.");
  if (data.supportsIterations !== true) throw new UserError("This PR does not support iteration-pinned reviews.");
  if (data.hasMultipleMergeBases === true) throw new UserError("This PR has multiple merge bases; review it in Azure DevOps.");
  if (!["active", "completed", "abandoned"].includes(String(data.status))) throw new UserError("Unknown ADO PR status.");
  if (data.isDraft !== undefined && typeof data.isDraft !== "boolean") throw new UserError("Invalid ADO draft status.");
  const repo = object(data.repository);
  const project = object(repo.project);
  const repositoryId = guid(repo.id);
  const projectId = guid(project.id);
  const repositoryName = text(repo.name);
  const projectName = text(project.name);
  if (![repositoryId, repositoryName.toLowerCase()].includes(target.repository.toLowerCase()) ||
      ![projectId, projectName.toLowerCase()].includes(target.project.toLowerCase())) {
    throw new UserError("The returned PR does not belong to the requested repository/project.");
  }
  const sourceRef = text(data.sourceRefName);
  const targetRef = text(data.targetRefName);
  if (![sourceRef, targetRef].every((ref) => ref.startsWith("refs/heads/"))) {
    throw new UserError("Azure DevOps returned an unsupported PR branch reference.");
  }
  return {
    id: target.id, repositoryId, projectId, repositoryName, projectName,
    title: text(data.title), author: text(object(data.createdBy).displayName),
    sourceRef, targetRef, status: data.status as PrMetadata["status"], draft: data.isDraft === true,
  };
}

export function parseIteration(value: unknown): Iteration {
  const data = object(value);
  if (!Array.isArray(data.value) || !data.value.length || data.value.length > 10_000 ||
      (data.count !== undefined && data.count !== data.value.length)) {
    throw new UserError("Azure DevOps returned an empty or incomplete iteration list.");
  }
  let latest: Record<string, unknown> | undefined;
  const ids = new Set<number>();
  for (const raw of data.value) {
    const entry = object(raw);
    const id = integer(entry.id);
    if (ids.has(id)) throw new UserError("Azure DevOps returned duplicate iteration IDs.");
    ids.add(id);
    if (!latest || id > Number(latest.id)) latest = entry;
  }
  return {
    id: integer(latest!.id),
    base: commitId(object(latest!.commonRefCommit).commitId),
    source: commitId(object(latest!.sourceRefCommit).commitId),
    target: commitId(object(latest!.targetRefCommit).commitId),
  };
}

/** Only canonical URLs on the selected organization's dev.azure.com API are constructed. */
export class AdoClient {
  readonly target: PullRequestTarget;
  readonly credential: Credential;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;

  constructor(target: PullRequestTarget, credential: Credential, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000) {
    // Revalidate at the transport boundary, not just at the CLI parser.
    this.target = parsePrUrl(pullRequestUrl(target));
    this.credential = credential;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(suffix: string, signal: AbortSignal): Promise<unknown> {
    const { organization, project, repository, id } = this.target;
    const path = [organization, project].map(encodeURIComponent).join("/");
    const url = `https://dev.azure.com/${path}/_apis/git/repositories/${encodeURIComponent(repository)}/pullRequests/${id}${suffix}?api-version=7.1`;
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      boundedSignal.throwIfAborted();
      const response = await this.fetchImpl(url, {
        method: "GET", redirect: "manual", signal: boundedSignal,
        headers: { Accept: "application/json", Authorization: this.credential.authorization, "User-Agent": "hunk-ado/0.1.0" },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new UserError("Azure DevOps rejected the credential. Refresh your token or az login.");
        if (response.status === 403) throw new UserError("Azure DevOps denied access. Check organization access and Code (Read) permission.");
        if (response.status === 404) throw new UserError("PR not found or inaccessible. Check the URL and credential permissions.");
        if (response.status === 429) throw new UserError("Azure DevOps rate limited this request. Wait and retry.");
        if (response.status >= 300 && response.status < 400) throw new UserError("Azure DevOps redirected the request; refusing to forward credentials.");
        throw new UserError(`Azure DevOps returned HTTP ${response.status}.`);
      }
      if (response.redirected || response.headers.get("x-ms-continuationtoken")) {
        await response.body?.cancel();
        throw new UserError("Azure DevOps returned a redirected or incomplete response.");
      }
      if (Number(response.headers.get("content-length")) > MAX_METADATA_BYTES) {
        await response.body?.cancel();
        throw new UserError("ADO metadata exceeds the 2 MiB safety limit.");
      }
      if (!response.body) throw new UserError("Azure DevOps returned empty metadata.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          boundedSignal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_METADATA_BYTES) throw new UserError("ADO metadata exceeds the 2 MiB safety limit.");
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      boundedSignal.throwIfAborted();
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new UserError("Azure DevOps returned malformed JSON metadata."); }
    } catch (error) {
      if (signal.aborted) throw new UserError("ADO PR loading was cancelled.");
      if (boundedSignal.aborted) throw new UserError("Azure DevOps metadata request timed out.");
      if (error instanceof UserError) throw error;
      // Do not surface response bodies, URLs, or arbitrary transport exception text.
      throw new UserError("Could not read Azure DevOps metadata. Check your network and TLS configuration.");
    }
  }

  async snapshot(signal: AbortSignal): Promise<PrSnapshot> {
    const pr = parseMetadata(await this.request("", signal), this.target);
    const iteration = parseIteration(await this.request("/iterations", signal));
    return { pr, iteration };
  }
}

export function assertSameSnapshot(before: PrSnapshot, after: PrSnapshot): void {
  const identity = ({ pr, iteration }: PrSnapshot) => JSON.stringify([
    pr.id, pr.repositoryId, pr.projectId, pr.sourceRef, pr.targetRef, pr.status,
    iteration.id, iteration.base, iteration.source, iteration.target,
  ]);
  if (identity(before) !== identity(after)) {
    throw new UserError("The PR changed while its patch was loading. Rerun hunk ado pr to review the new iteration.");
  }
}

function display(value: string, bytes: number): string {
  let out = "";
  // Terminal controls and bidi formatting must not survive into host display metadata.
  for (const c of value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")) {
    if (Buffer.byteLength(out + c) > bytes) break;
    out += c;
  }
  return out.trim() || "(unknown)";
}

export function reviewDescriptor(snapshot: PrSnapshot, target: PullRequestTarget): ExtensionChangeRequestReviewDescriptor {
  const { pr } = snapshot;
  const result: ExtensionChangeRequestReviewDescriptor = {
    kind: "change-request", provider: "Azure DevOps", id: `!${pr.id}`,
    title: display(pr.title, 512), url: pullRequestUrl(target),
    repository: display(`${target.organization}/${pr.projectName}/${pr.repositoryName}`, 192),
    author: display(pr.author, 128),
    base: display(pr.targetRef.slice("refs/heads/".length), 128),
    head: display(pr.sourceRef.slice("refs/heads/".length), 128),
    state: { active: "open", completed: "merged", abandoned: "closed" }[pr.status] as "open" | "merged" | "closed",
    draft: pr.draft,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 4096) throw new UserError("PR display metadata exceeds Hunk's safety limit.");
  return result;
}
