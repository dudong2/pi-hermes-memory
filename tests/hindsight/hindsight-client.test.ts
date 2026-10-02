import assert from "node:assert/strict";
import test from "node:test";
import {
  HindsightClient,
  HindsightHttpError,
} from "../../src/hindsight/client.js";

test("HindsightClient encodes bank IDs and forwards caller cancellation", async () => {
  let requestUrl = "";
  let requestSignal: AbortSignal | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestSignal = init?.signal as AbortSignal;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  const caller = new AbortController();
  const client = new HindsightClient({
    apiUrl: "http://127.0.0.1:18910",
    apiToken: "secret",
    fetchImpl,
  });
  await client.recall(
    "coding-agent::dudong2",
    { query: "test" },
    caller.signal,
  );
  assert.match(requestUrl, /coding-agent%3A%3Adudong2/);
  assert.equal(requestSignal?.aborted, false);
  caller.abort();
  assert.equal(requestSignal?.aborted, true);
});

test("HindsightClient surfaces bounded HTTP errors without credentials", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(JSON.stringify({ detail: "denied" }), { status: 401 });
  const client = new HindsightClient({
    apiUrl: "http://localhost:1",
    apiToken: "do-not-leak",
    fetchImpl,
  });
  await assert.rejects(
    client.health(),
    (error: unknown) =>
      error instanceof HindsightHttpError &&
      error.status === 401 &&
      !error.message.includes("do-not-leak"),
  );
});

test("HindsightClient timeout aborts an in-flight request", async () => {
  const fetchImpl: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    });
  const client = new HindsightClient({
    apiUrl: "http://localhost:1",
    requestTimeoutMs: 10,
    fetchImpl,
  });
  await assert.rejects(client.health(), /timeout|aborted/i);
});
