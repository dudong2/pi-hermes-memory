import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RetainOutbox } from "../../src/hindsight/outbox.js";
import { HindsightClient } from "../../src/hindsight/client.js";
import { tempRoot } from "../scope/fixtures.js";

function fake() { return { retain: async () => ({}), operationStatus: async () => ({ status: "completed" }) }; }

test("an old claim with a live owner is never recovered solely because time elapsed", async () => {
  const root = await tempRoot("outbox-live-owner-");
  let now = Date.now();
  const outbox = new RetainOutbox({ rootDir: root, staleClaimMs: 100, clock: () => now });
  const job = await outbox.enqueue({ identity: "live-owner", bankId: "old-bank", item: { content: "fact" } });
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((done) => { started = done; });
  const gate = new Promise<void>((done) => { finish = done; });
  const draining = outbox.drain({ retain: async () => { started(); await gate; return {}; }, operationStatus: async () => ({ status: "completed" }) });
  await entered;
  now += 1000;
  const claimed = (await readdir(join(root, "processing")))[0];
  await utimes(join(root, "processing", claimed), new Date(now - 1000), new Date(now - 1000));
  let recovered: number;
  try { recovered = await outbox.recoverStaleClaims(); }
  finally { finish(); await draining.catch(() => {}); }
  assert.equal(recovered!, 0);
  assert.deepEqual(await outbox.counts(), { pending: 0, processing: 0, failed: 0 });
  assert.match(job.operationId, /^[0-9a-f-]+$/);
});

test("new secret-bearing content is rejected before it reaches the durable outbox", async () => {
  const root = await tempRoot("outbox-secret-");
  const outbox = new RetainOutbox({ rootDir: root });
  const value = "sk-" + "x".repeat(32);
  await assert.rejects(outbox.enqueue({ identity: "secret", bankId: "test", item: { content: value } }), /secret/i);
  assert.deepEqual(await outbox.counts(), { pending: 0, processing: 0, failed: 0 });
});

test("unsafe identifiers are quarantined without escaping the queue or contacting a server", async () => {
  const root = await tempRoot("outbox-bad-id-");
  const outbox = new RetainOutbox({ rootDir: root });
  const job = await outbox.enqueue({ identity: "unsafe", bankId: "test", item: { content: "fact" } });
  const path = join(root, "pending", job.id + ".json");
  await writeFile(path, JSON.stringify({ ...job, id: "../outside", operationId: "../outside" }));
  let requested = false;
  const result = await outbox.drain({ retain: async () => { requested = true; return {}; }, operationStatus: async () => ({ status: "completed" }) });
  assert.equal(result.failed, 1);
  assert.equal(requested, false);
});

test("existing queued operation IDs and bank destinations are not regenerated during handoff", async () => {
  const root = await tempRoot("outbox-existing-job-");
  const before = new RetainOutbox({ rootDir: root });
  const job = await before.enqueue({ identity: "legacy-source", bankId: "old-bank", item: { content: "preserved fact", metadata: { source: "pi-memory-orchestrator", harness: "omp" } } });
  const bytes = await readFile(join(root, "pending", job.id + ".json"));
  const after = new RetainOutbox({ rootDir: root });
  const sent: unknown[] = [];
  await after.drain({ retain: async (bank: string, request: { operation_id: string; items: { content: string }[] }) => { sent.push({ bank, id: request.operation_id, content: request.items[0].content }); return {}; }, operationStatus: fake().operationStatus });
  assert.deepEqual(sent, [{ bank: "old-bank", id: job.operationId, content: "preserved fact" }]);
  assert.ok(bytes.length > 0);
});

test("retry metadata never persists credential-bearing server error details", async () => {
  const root = await tempRoot("outbox-secret-error-");
  const outbox = new RetainOutbox({ rootDir: root });
  const job = await outbox.enqueue({ identity: "failed-request", bankId: "test", item: { content: "safe fact" } });
  const value = "sk-" + "z".repeat(32);
  await outbox.drain({ retain: async () => { throw new Error(value); }, operationStatus: fake().operationStatus });
  assert.equal((await readFile(join(root, "pending", job.id + ".json"), "utf8")).includes(value), false);
});

test("redirects cannot forward an approved API credential to another endpoint", async () => {
  let redirect: RequestRedirect | undefined;
  const client = new HindsightClient({ apiUrl: "http://127.0.0.1:1", apiToken: "fixture-credential", fetchImpl: async (_input, options) => {
    redirect = options?.redirect;
    return new Response("{}", { status: 200 });
  } });
  await client.health();
  assert.equal(redirect, "error");
});
