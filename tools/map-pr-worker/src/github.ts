// Minimal GitHub REST client for the map PR worker (T4.5): read a ref and files of the base
// branch, write blobs, a tree, a commit and a branch with the Git Data API, and open or
// find the pull request. No git clone, no shell: everything is HTTP with a fine-grained
// token (docs/09, "Worker de PR de mapas"). The token only ever goes in the Authorization
// header; errors carry the method, the path and the status, never the token or a body.

/**
 * A failed GitHub call. `retryable`: transient (network, 5xx, rate limit), worth trying
 * again later. `config`: the operator's problem (bad or expired token, missing permission,
 * wrong repository or base branch): the submission waits without spending its attempts.
 * Neither: the answer will not change (a file that is not UTF-8...).
 */
export class GitHubError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly config: boolean;
  constructor(message: string, status: number, retryable: boolean, config = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.config = config;
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
  /** Its description (the worker checks its marker before trusting a found PR). */
  body: string;
}

export interface TreeEntry {
  path: string;
  /** The file's new text, or null to delete it. */
  content: string | null;
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
  const body = (raw as { body?: unknown }).body;
  return {
    number: p.number,
    url: p.html_url,
    state: typeof p.state === "string" ? p.state : "",
    body: typeof body === "string" ? body : "",
  };
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
  ): Promise<{ status: number; data: unknown; bytes: Uint8Array; headers: Headers }> {
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
    return { status: res.status, data, bytes, headers: res.headers };
  }

  private fail(
    method: string,
    path: string,
    r: { status: number; data?: unknown; headers: Headers },
  ): never {
    // Rate limits answer 429, or 403 with retry-after or no remaining requests: transient.
    // 401, 404 and any other 403 are configuration (token, permissions, repository).
    const msg = (r.data as { message?: unknown } | undefined)?.message;
    const hint =
      typeof msg === "string" ? `: ${msg.slice(0, 120).replace(/[^\x20-\x7e]/g, "?")}` : "";
    const limited =
      r.status === 429 ||
      (r.status === 403 &&
        (r.headers.has("retry-after") || r.headers.get("x-ratelimit-remaining") === "0"));
    const config = !limited && (r.status === 401 || r.status === 403 || r.status === 404);
    throw new GitHubError(
      `${method} ${path}: HTTP ${String(r.status)}${hint}`,
      r.status,
      !config,
      config,
    );
  }

  private repoPath(rest: string): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${rest}`;
  }

  /** The commit a branch points at, or null if there is no such branch. */
  async branchSha(branch: string): Promise<string | null> {
    const path = this.repoPath(`/git/ref/heads/${encodePath(branch)}`);
    const r = await this.request("GET", path);
    if (r.status === 404) return null;
    if (r.status !== 200) this.fail("GET", path, r);
    const sha = (r.data as { object?: { sha?: unknown } }).object?.sha;
    if (typeof sha !== "string") throw new GitHubError(`GET ${path}: no sha`, 0, true);
    return sha;
  }

  /** The message of a commit (the worker checks its trailer before reusing a branch). */
  async commitMessage(sha: string): Promise<string> {
    const path = this.repoPath(`/git/commits/${encodeURIComponent(sha)}`);
    const r = await this.request("GET", path);
    if (r.status !== 200) this.fail("GET", path, r);
    const message = (r.data as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }

  /** The tree of a commit. */
  async commitTree(sha: string): Promise<string> {
    const path = this.repoPath(`/git/commits/${encodeURIComponent(sha)}`);
    const r = await this.request("GET", path);
    if (r.status !== 200) this.fail("GET", path, r);
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
    if (r.status !== 200) this.fail("GET", path, r);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(r.bytes);
    } catch {
      throw new GitHubError(`GET ${path}: not UTF-8`, 0, false);
    }
  }

  /**
   * A tree on top of baseTree: regular files (100644) with their text inline, or
   * deletions. One request for the whole change, whatever its number of files (GitHub
   * limits how many objects may be created per minute).
   */
  async createTree(baseTree: string, entries: readonly TreeEntry[]): Promise<string> {
    const path = this.repoPath("/git/trees");
    const tree = entries.map((e) =>
      e.content === null
        ? { path: e.path, mode: "100644", type: "blob", sha: null }
        : { path: e.path, mode: "100644", type: "blob", content: e.content },
    );
    const r = await this.request("POST", path, { base_tree: baseTree, tree });
    if (r.status !== 201) this.fail("POST", path, r);
    return shaOf(r.data, path);
  }

  async createCommit(message: string, tree: string, parents: readonly string[]): Promise<string> {
    const path = this.repoPath("/git/commits");
    const r = await this.request("POST", path, { message, tree, parents });
    if (r.status !== 201) this.fail("POST", path, r);
    return shaOf(r.data, path);
  }

  /** Creates the branch; false when it already exists (a retry after a crash). */
  async createBranch(branch: string, sha: string): Promise<boolean> {
    const path = this.repoPath("/git/refs");
    const r = await this.request("POST", path, { ref: `refs/heads/${branch}`, sha });
    if (r.status === 201) return true;
    if (r.status === 422 && (await this.branchSha(branch)) !== null) return false;
    this.fail("POST", path, r);
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
    if (r.status !== 200) this.fail("GET", path, r);
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
    this.fail("POST", path, r);
  }
}

function shaOf(data: unknown, path: string): string {
  const sha = (data as { sha?: unknown } | undefined)?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/.test(sha))
    throw new GitHubError(`${path}: no sha in the response`, 0, true);
  return sha;
}
