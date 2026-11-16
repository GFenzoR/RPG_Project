import { describe, expect, it } from "vitest";
import {
  ASSET_RETRY,
  HttpStatusError,
  fetchJSON,
  fetchJSONWithRetry,
  retryDelay,
  retryDelays,
  withRetry,
} from "./retry.ts";
import type { RetryPolicy } from "./retry.ts";

/** A sleep that only records the waits it was asked for. */
function fakeSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

/** A task that fails its first `n` attempts, then answers "ok". */
function failing(n: number): { calls: number[]; task: (attempt: number) => Promise<string> } {
  const calls: number[] = [];
  return {
    calls,
    task: (attempt) => {
      calls.push(attempt);
      return calls.length <= n
        ? Promise.reject(new Error(`attempt ${attempt} failed`))
        : Promise.resolve("ok");
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("retry policy", () => {
  it("waits longer each time, up to the ceiling", () => {
    const p: RetryPolicy = { attempts: 6, firstDelayMs: 500, factor: 2, maxDelayMs: 3000 };
    expect(retryDelays(p)).toEqual([500, 1000, 2000, 3000, 3000]);
    expect(retryDelay(p, 1)).toBe(500);
    expect(retryDelay(p, 0)).toBe(500);
  });

  it("the assets' policy: four attempts, 3.5 s of waits at most", () => {
    expect(ASSET_RETRY.attempts).toBe(4);
    expect(retryDelays(ASSET_RETRY)).toEqual([500, 1000, 2000]);
  });

  it("one attempt means no retry", () => {
    expect(retryDelays({ attempts: 1, firstDelayMs: 500, factor: 2, maxDelayMs: 1000 })).toEqual(
      [],
    );
  });
});

describe("withRetry", () => {
  it("returns the first success, after waiting the policy's delays", async () => {
    const { waits, sleep } = fakeSleep();
    const { calls, task } = failing(2);
    await expect(withRetry(task, { sleep })).resolves.toBe("ok");
    expect(calls).toEqual([1, 2, 3]);
    expect(waits).toEqual([500, 1000]);
  });

  it("does not wait when the first attempt works", async () => {
    const { waits, sleep } = fakeSleep();
    const { calls, task } = failing(0);
    await expect(withRetry(task, { sleep })).resolves.toBe("ok");
    expect(calls).toEqual([1]);
    expect(waits).toEqual([]);
  });

  it("gives up after the last attempt with its error", async () => {
    const { waits, sleep } = fakeSleep();
    const { calls, task } = failing(10);
    await expect(withRetry(task, { sleep })).rejects.toThrow("attempt 4 failed");
    expect(calls).toEqual([1, 2, 3, 4]);
    // No wait after the last attempt: the caller shows the error right away.
    expect(waits).toEqual([500, 1000, 2000]);
  });

  it("follows another policy", async () => {
    const { waits, sleep } = fakeSleep();
    const { calls, task } = failing(10);
    const policy = { attempts: 2, firstDelayMs: 10, factor: 3, maxDelayMs: 100 };
    await expect(withRetry(task, { policy, sleep })).rejects.toThrow("attempt 2 failed");
    expect(calls).toEqual([1, 2]);
    expect(waits).toEqual([10]);
  });
});

describe("fetchJSON", () => {
  it("parses a successful response", async () => {
    await expect(
      fetchJSON("http://x/a.json", () => Promise.resolve(json({ a: 1 }))),
    ).resolves.toEqual({ a: 1 });
  });

  it("rejects an error status like a network error", async () => {
    const err = await fetchJSON("http://x/a.json", () =>
      Promise.resolve(new Response("busy", { status: 502 })),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect((err as HttpStatusError).status).toBe(502);
    expect((err as HttpStatusError).url).toBe("http://x/a.json");
  });

  it("retries a refused connection and an error status, then answers", async () => {
    const { waits, sleep } = fakeSleep();
    let n = 0;
    const fetcher = (): Promise<Response> => {
      n++;
      if (n === 1) return Promise.reject(new TypeError("Failed to fetch"));
      if (n === 2) return Promise.resolve(new Response("", { status: 503 }));
      return Promise.resolve(json({ version: 1 }));
    };
    await expect(fetchJSONWithRetry("http://x/atlas.json", { fetcher, sleep })).resolves.toEqual({
      version: 1,
    });
    expect(n).toBe(3);
    expect(waits).toEqual([500, 1000]);
  });
});
