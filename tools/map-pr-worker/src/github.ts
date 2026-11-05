// Minimal GitHub REST client for the map PR worker (T4.5): read a ref and files of the base
// branch, write blobs, a tree, a commit and a branch with the Git Data API, and open or
// find the pull request. No git clone, no shell: everything is HTTP with a fine-grained
// token (docs/09, "Worker de PR de mapas"). The token only ever goes in the Authorization
// header; errors carry the method, the path and the status, never the token or a body.

/** A failed GitHub call. `retryable`: worth trying again later (network, 5xx, rate limit). */
export class GitHubError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export interface GitHubOptions {
  /** API root, https://api.github.com in production; the fake GitHub in tests. */
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  /** Per request (default 30 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface PullRequest {
  number: number;
  url: string;
  state: string;
}

export interface TreeEntry {
  path: string;
  /** Blob sha, or null to delete the file. */
  sha: string | null;
}

const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Splits "owner/repo", or undefined when it does not look like one. */
export function parseRepository(s: string): { owner: string; repo: string } | undefined {
  if (!OWNER_REPO.test(s) || s.endsWith("/.") || s.endsWith("/..")) return undefined;
  const [owner, repo] = s.split("/") as [string, string];
  return { owner, repo };
}

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** The URL of a pull request: only https URLs of the API's own GitHub are trusted. */
function pullOf(raw: unknown): PullRequest {
  const p = raw as { number?: unknown; html_url?: unknown; state?: unknown };
  if (
    typeof p.number !== "number" ||
    !Number.isInteger(p.number) ||
    p.number <= 0 ||
    typeof p.html_url !== "string" ||
    !/^https:\/\/[^\s"<>]+$/.test(p.html_url)
  )
    throw new GitHubError("unexpected pull request in the response", 0, false);
  return { number: p.number, url: p.html_url, state: typeof p.state === "string" ? p.state : "" };
}

export class GitHub {
  readonly owner: string;
  readonly repo: string;
  private readonly opts: GitHubOptions;
  private readonly doFetch: typeof fetch;

  constructor(opts: GitHubOptions) {
    this.opts = opts;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.doFetch = opts.fetch ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<{ status: number; data: unknown; bytes: Uint8Array }> {
    const url = `${this.opts.apiUrl.replace(/\/+$/, "")}${path}`;
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.opts.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "rpg-project-map-pr-worker",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        redirect: "error",
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "error";
      throw new GitHubError(`${method} ${path}: network (${name})`, 0, true);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    let data: unknown;
    if (accept.endsWith("+json") || accept === "application/json") {
      try {
        data = bytes.length === 0 ? undefined : JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        data = undefined;
      }
    }
    return { status: res.status, data, bytes };
  }

  private fail(method: string, path: string, status: number, data?: unknown): never {
    // Rate limits answer 403 or 429; 5xx and 408 are transient. 401/403/404 are a
    // configuration problem (token, permissions, repository): retrying later lets the
    // operator fix it without failing anyone's submission.
    const msg = (data as { message?: unknown } | undefined)?.message;
    const hint =
      typeof msg === "string" ? `: ${msg.slice(0, 120).replace(/[^\x20-\x7e]/g, "?")}` : "";
    throw new GitHubError(`${method} ${path}: HTTP ${status}${hint}`, status, true);
  }

  private repoPath(rest: string): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${rest}`;
  }

  /** The commit a branch points at, or null if there is no such branch. */
  async branchSha(branch: string): Promise<string | null> {
    const path = this.repoPath(`/git/ref/heads/${encodePath(branch)}`);
    const r = await this.request("GET", path);
    if (r.status === 404) return null;
    if (r.status !== 200) this.fail("GET", path, r.status, r.data);
    const sha = (r.data as { object?: { sha?: unknown } }).object?.sha;
    if (typeof sha !== "string") throw new GitHubError(`GET ${path}: no sha`, 0, true);
    return sha;
  }

  /** The tree of a commit. */
  async commitTree(sha: string): Promise<string> {
    const path = this.repoPath(`/git/commits/${encodeURIComponent(sha)}`);
    const r = await this.request("GET", path);
    if (r.status !== 200) this.fail("GET", path, r.status, r.data);
    const tree = (r.data as { tree?: { sha?: unknown } }).tree?.sha;
    if (typeof tree !== "string") throw new GitHubError(`GET ${path}: no tree`, 0, true);
    return tree;
  }

  /**
   * A file's text at a commit, or null when it does not exist there. Not UTF-8 is an
   * error: map files always are.
   */
  async fileAt(filePath: string, ref: string): Promise<string | null> {
    const path = this.repoPath(`/contents/${encodePath(filePath)}?ref=${encodeURIComponent(ref)}`);
    const r = await this.request("GET", path, undefined, "application/vnd.github.raw+json");
    if (r.status === 404) return null;
    if (r.status !== 200) this.fail("GET", path, r.status);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(r.bytes);
    } catch {
      throw new GitHubError(`GET ${path}: not UTF-8`, 0, false);
    }
  }

  async createBlob(content: string): Promise<string> {
    const path = this.repoPath("/git/blobs");
    const r = await this.request("POST", path, { content, encoding: "utf-8" });
    if (r.status !== 201) this.fail("POST", path, r.status, r.data);
    return shaOf(r.data, path);
  }

  /** A tree on top of baseTree: regular files (100644) or deletions. */
  async createTree(baseTree: string, entries: readonly TreeEntry[]): Promise<string> {
    const path = this.repoPath("/git/trees");
    const tree = entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha }));
    const r = await this.request("POST", path, { base_tree: baseTree, tree });
    if (r.status !== 201) this.fail("POST", path, r.status, r.data);
    return shaOf(r.data, path);
  }

  async createCommit(message: string, tree: string, parents: readonly string[]): Promise<string> {
    const path = this.repoPath("/git/commits");
    const r = await this.request("POST", path, { message, tree, parents });
    if (r.status !== 201) this.fail("POST", path, r.status, r.data);
    return shaOf(r.data, path);
  }

  /** Creates the branch; false when it already exists (a retry after a crash). */
  async createBranch(branch: string, sha: string): Promise<boolean> {
    const path = this.repoPath("/git/refs");
    const r = await this.request("POST", path, { ref: `refs/heads/${branch}`, sha });
    if (r.status === 201) return true;
    if (r.status === 422 && (await this.branchSha(branch)) !== null) return false;
    this.fail("POST", path, r.status, r.data);
  }

  /** The newest pull request (any state) whose head is `branch` of this repository. */
  async findPull(branch: string): Promise<PullRequest | null> {
    const q = new URLSearchParams({
      head: `${this.owner}:${branch}`,
      state: "all",
      per_page: "10",
    });
    const path = this.repoPath(`/pulls?${q.toString()}`);
    const r = await this.request("GET", path);
    if (r.status !== 200) this.fail("GET", path, r.status, r.data);
    if (!Array.isArray(r.data) || r.data.length === 0) return null;
    return pullOf(r.data[0]);
  }

  /** Opens the pull request, or returns the one already open from that branch. */
  async openPull(p: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<PullRequest> {
    const path = this.repoPath("/pulls");
    const r = await this.request("POST", path, { ...p, maintainer_can_modify: true });
    if (r.status === 201) return pullOf(r.data);
    if (r.status === 422) {
      const existing = await this.findPull(p.head);
      if (existing) return existing;
    }
    this.fail("POST", path, r.status, r.data);
  }
}

function shaOf(data: unknown, path: string): string {
  const sha = (data as { sha?: unknown } | undefined)?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/.test(sha))
    throw new GitHubError(`${path}: no sha in the response`, 0, true);
  return sha;
}
