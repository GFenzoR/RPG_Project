// A fake of the GitHub REST endpoints the map PR worker uses (T4.5), for unit tests and
// the E2E: refs, contents of a commit, blobs, trees, commits and pull requests, kept in
// memory. The base commit's files come from a function (the repo's own world/ in the
// E2E), so nothing is copied. Failures can be injected per route to test retries.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open";
}

export interface FakeCommit {
  tree: string;
  parents: string[];
  message: string;
}

/** A tree: changes on top of a parent tree; the root reads the base files. */
interface Tree {
  parent: string | null;
  /** path → blob sha, or null when deleted. */
  entries: Map<string, string | null>;
}

export interface FakeGitHubOptions {
  owner: string;
  repo: string;
  token: string;
  /** Base branch and its files (null: not there). */
  base?: string;
  readBase: (path: string) => string | null;
  /** Who the token is (GET /user); default a bot that is neither owner nor maintainer. */
  login?: string;
}

export interface Failure {
  /** "POST /pulls", "GET /contents"…: method and the first path segment after the repo. */
  route: string;
  status: number;
  /** How many requests fail (default 1). */
  times?: number;
  /**
   * How: an error status (default), a 200 whose body is cut short ("truncate"), a 200
   * that never finishes its body ("stall") or a 200 with an empty body ("empty").
   */
  mode?: "status" | "truncate" | "stall" | "empty";
  headers?: Record<string, string>;
}

export interface FakeGitHub {
  url: string;
  pulls: FakePull[];
  refs: Map<string, string>;
  commits: Map<string, FakeCommit>;
  /** "METHOD /route" of every request, in order. */
  requests: string[];
  fail(f: Failure): void;
  /** A file's text on a branch (null: not there). */
  fileOn(branch: string, path: string): string | null;
  close(): Promise<void>;
}

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

export async function startFakeGitHub(o: FakeGitHubOptions): Promise<FakeGitHub> {
  const base = o.base ?? "main";
  const blobs = new Map<string, string>();
  const trees = new Map<string, Tree>([["t0", { parent: null, entries: new Map() }]]);
  const commits = new Map<string, FakeCommit>([
    ["c".repeat(40), { tree: "t0", parents: [], message: "base" }],
  ]);
  const refs = new Map<string, string>([[base, "c".repeat(40)]]);
  const pulls: FakePull[] = [];
  const requests: string[] = [];
  const failures: (Failure & { times: number })[] = [];
  const stalled: ServerResponse[] = [];
  const prefix = `/repos/${o.owner}/${o.repo}`;

  const readTree = (treeSha: string, path: string): string | null => {
    for (let t = trees.get(treeSha); t; t = t.parent === null ? undefined : trees.get(t.parent)) {
      if (t.entries.has(path)) {
        const blob = t.entries.get(path);
        return blob === null || blob === undefined ? null : (blobs.get(blob) ?? null);
      }
      if (t.parent === null) return o.readBase(path);
    }
    return null;
  };
  const resolve = (ref: string): string | undefined => (commits.has(ref) ? ref : refs.get(ref));

  const send = (res: ServerResponse, status: number, data?: unknown, raw?: string): void => {
    res.writeHead(status, {
      "Content-Type": raw === undefined ? "application/json" : "application/octet-stream",
    });
    res.end(raw ?? (data === undefined ? "" : JSON.stringify(data)));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (req.headers.authorization !== `Bearer ${o.token}`)
      return send(res, 401, { message: "Bad credentials" });
    if (req.method === "GET" && url.pathname === "/user") {
      requests.push("GET /user");
      return send(res, 200, { login: o.login ?? "rpg-map-bot" });
    }
    if (!url.pathname.startsWith(`${prefix}/`)) return send(res, 404, { message: "Not Found" });
    const rest = decodeURIComponent(url.pathname.slice(prefix.length));
    const route = `${req.method ?? ""} /${rest.split("/")[1] === "git" ? `git/${rest.split("/")[2] ?? ""}` : (rest.split("/")[1] ?? "")}`;
    requests.push(route);
    const f = failures.find((x) => x.route === route && x.times > 0);
    if (f) {
      f.times--;
      if (f.mode === "truncate") {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100000" });
        res.write('{"sha":"');
        return void setTimeout(() => res.socket?.destroy(), 20);
      }
      if (f.mode === "stall") {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "100000" });
        res.write('{"sha":"');
        stalled.push(res);
        return;
      }
      if (f.mode === "empty") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return void res.end();
      }
      res.writeHead(f.status, { "Content-Type": "application/json", ...f.headers });
      return void res.end(JSON.stringify({ message: "injected failure" }));
    }
    const body = (await bodyOf(req)) as Record<string, unknown> | undefined;
    let m: RegExpExecArray | null;
    if (req.method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = refs.get(m[1] ?? "");
      return sha
        ? send(res, 200, { ref: `refs/heads/${m[1] ?? ""}`, object: { sha, type: "commit" } })
        : send(res, 404, { message: "Not Found" });
    }
    if (req.method === "GET" && (m = /^\/git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const c = commits.get(m[1] ?? "");
      return c
        ? send(res, 200, { sha: m[1], tree: { sha: c.tree }, message: c.message })
        : send(res, 404, { message: "Not Found" });
    }
    if (req.method === "GET" && (m = /^\/contents\/(.+)$/.exec(rest))) {
      const commit = commits.get(resolve(url.searchParams.get("ref") ?? base) ?? "");
      const text = commit ? readTree(commit.tree, m[1] ?? "") : null;
      return text === null
        ? send(res, 404, { message: "Not Found" })
        : send(res, 200, undefined, text);
    }
    if (req.method === "POST" && rest === "/git/blobs") {
      const content = String(body?.["content"] ?? "");
      const sha = sha1(`blob ${content}`);
      blobs.set(sha, content);
      return send(res, 201, { sha });
    }
    if (req.method === "POST" && rest === "/git/trees") {
      const parent = String(body?.["base_tree"] ?? "");
      if (!trees.has(parent)) return send(res, 422, { message: "base_tree not found" });
      const entries = new Map<string, string | null>();
      for (const e of (body?.["tree"] ?? []) as {
        path: string;
        sha?: string | null;
        content?: string;
        mode: string;
      }[]) {
        if (e.mode !== "100644") return send(res, 422, { message: "bad entry" });
        if (typeof e.content === "string") {
          const blob = sha1(`blob ${e.content}`);
          blobs.set(blob, e.content);
          entries.set(e.path, blob);
        } else if (e.sha === null || (typeof e.sha === "string" && blobs.has(e.sha))) {
          entries.set(e.path, e.sha);
        } else return send(res, 422, { message: "bad entry" });
      }
      const sha = sha1(`tree ${parent} ${JSON.stringify([...entries])}`);
      trees.set(sha, { parent, entries });
      return send(res, 201, { sha });
    }
    if (req.method === "POST" && rest === "/git/commits") {
      const tree = String(body?.["tree"] ?? "");
      const parents = (body?.["parents"] ?? []) as string[];
      if (!trees.has(tree) || parents.some((p) => !commits.has(p)))
        return send(res, 422, { message: "bad commit" });
      const message = String(body?.["message"] ?? "");
      const sha = sha1(`commit ${tree} ${parents.join(",")} ${message}`);
      commits.set(sha, { tree, parents, message });
      return send(res, 201, { sha });
    }
    if (req.method === "POST" && rest === "/git/refs") {
      const ref = String(body?.["ref"] ?? "");
      const sha = String(body?.["sha"] ?? "");
      if (!ref.startsWith("refs/heads/") || !commits.has(sha))
        return send(res, 422, { message: "bad ref" });
      const name = ref.slice("refs/heads/".length);
      if (refs.has(name)) return send(res, 422, { message: "Reference already exists" });
      refs.set(name, sha);
      return send(res, 201, { ref, object: { sha } });
    }
    if (req.method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head") ?? "";
      const branch = head.startsWith(`${o.owner}:`) ? head.slice(o.owner.length + 1) : head;
      const found = pulls.filter((p) => p.head === branch).reverse();
      return send(
        res,
        200,
        found.map((p) => pullJSON(p)),
      );
    }
    if (req.method === "POST" && rest === "/pulls") {
      const head = String(body?.["head"] ?? "");
      if (!refs.has(head)) return send(res, 422, { message: "head not found" });
      if (pulls.some((p) => p.head === head))
        return send(res, 422, { message: "A pull request already exists" });
      const p: FakePull = {
        number: pulls.length + 1,
        head,
        base: String(body?.["base"] ?? ""),
        title: String(body?.["title"] ?? ""),
        body: String(body?.["body"] ?? ""),
        state: "open",
      };
      pulls.push(p);
      return send(res, 201, pullJSON(p));
    }
    return send(res, 404, { message: "Not Found" });
  };
  const pullJSON = (p: FakePull): unknown => ({
    number: p.number,
    state: p.state,
    body: p.body,
    html_url: `https://github.com/${o.owner}/${o.repo}/pull/${String(p.number)}`,
    head: { ref: p.head },
  });

  const server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, { message: "fake error" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    pulls,
    refs,
    commits,
    requests,
    fail: (f) => failures.push({ times: 1, ...f }),
    fileOn: (branch, path) => {
      const c = commits.get(refs.get(branch) ?? "");
      return c ? readTree(c.tree, path) : null;
    },
    close: () => {
      for (const r of stalled) r.socket?.destroy();
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
