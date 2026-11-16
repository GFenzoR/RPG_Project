// Retrying a request that failed once on a flaky network (a phone changing cells, a dev
// server busy for a moment): a few attempts with a growing wait between them, then the
// last error, so the caller can show it with a "Retry" button. The waits come from the
// policy and the caller's sleep, so the tests need no clock. No PixiJS here: the site
// imports this module on its own (`@rpg/renderer/retry`).

export interface RetryPolicy {
  /** Attempts in all, the first one included (1 = no retry). */
  attempts: number;
  /** Wait before the second attempt, ms. */
  firstDelayMs: number;
  /** Each later wait is this many times the one before. */
  factor: number;
  /** Ceiling of a single wait, ms. */
  maxDelayMs: number;
}

/**
 * The atlas and the sprite previews: 4 attempts, waiting 0.5, 1 and 2 s between them, so
 * a request that keeps failing gives up after 3.5 s of waits (plus the requests).
 */
export const ASSET_RETRY: RetryPolicy = {
  attempts: 4,
  firstDelayMs: 500,
  factor: 2,
  maxDelayMs: 4000,
};

/** Wait before retry `n` (1 = the second attempt), ms: grows by `factor`, up to the ceiling. */
export function retryDelay(policy: RetryPolicy, n: number): number {
  const ms = policy.firstDelayMs * policy.factor ** Math.max(0, n - 1);
  return Math.max(0, Math.min(policy.maxDelayMs, ms));
}

/** Every wait of a policy, in order: one fewer than its attempts. */
export function retryDelays(policy: RetryPolicy): number[] {
  const out: number[] = [];
  for (let n = 1; n < policy.attempts; n++) out.push(retryDelay(policy, n));
  return out;
}

export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How a caller may change the retries (tests pass an instant sleep). */
export interface RetryOptions {
  policy?: RetryPolicy | undefined;
  sleep?: Sleep | undefined;
}

/**
 * Runs `task` (given its attempt, 1 = the first) until it resolves or the policy's
 * attempts run out; then rejects with the last attempt's error.
 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const policy = opts.policy ?? ASSET_RETRY;
  const wait = opts.sleep ?? sleep;
  const attempts = Math.max(1, Math.floor(policy.attempts));
  for (let attempt = 1; ; attempt++) {
    try {
      return await task(attempt);
    } catch (e) {
      if (attempt >= attempts) throw e;
      await wait(retryDelay(policy, attempt));
    }
  }
}

/** A response that arrived with an error status (a 404, or a 502 from a proxy). */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(url: string, status: number) {
    super(`GET ${url}: HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.url = url;
  }
}

export type Fetcher = (url: string) => Promise<Response>;

/** Fetches and parses a JSON document; an error status rejects like a network error. */
export async function fetchJSON(url: string, fetcher: Fetcher = (u) => fetch(u)): Promise<unknown> {
  const res = await fetcher(url);
  if (!res.ok) throw new HttpStatusError(url, res.status);
  return (await res.json()) as unknown;
}

/** fetchJSON with retries: each attempt fetches and parses the whole document again. */
export function fetchJSONWithRetry(
  url: string,
  opts: RetryOptions & { fetcher?: Fetcher | undefined } = {},
): Promise<unknown> {
  return withRetry(() => fetchJSON(url, opts.fetcher), opts);
}
