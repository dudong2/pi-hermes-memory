import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rename, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deterministicOperationId, RetainOutbox, type RetainOperations } from "../../src/hindsight/outbox.js";

class FakeOperations implements RetainOperations {
  readonly retained: string[] = [];
  readonly statuses = new Map<string, string>();
  async retain(_bankId: string, request: { operation_id: string }): Promise<unknown> {
    this.retained.push(request.operation_id);
    this.statuses.set(request.operation_id, "completed");
    return { operation_id: request.operation_id };
  }
  async operationStatus(_bankId: string, operationId: string): Promise<{ status: string }> {
    return { status: this.statuses.get(operationId) ?? "pending" };
  }
}

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "memory-outbox-"));
}

test("deterministicOperationId is stable and UUID-shaped", () => {
  const first = deterministicOperationId("session:turn:1");
  assert.equal(first, deterministicOperationId("session:turn:1"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("enqueue is idempotent and drain removes only completed jobs", async () => {
  const dir = await root();
  const outbox = new RetainOutbox({ rootDir: dir, pollIntervalMs: 1 });
  const input = { identity: "session:1", bankId: "bank", item: { content: "fact" } };
  await outbox.enqueue(input);
  await outbox.enqueue(input);
  assert.deepEqual(await outbox.counts(), { pending: 1, processing: 0, failed: 0 });
  const fake = new FakeOperations();
  assert.deepEqual(await outbox.drain(fake), { completed: 1, deferred: 0, failed: 0 });
  assert.equal(fake.retained.length, 1);
  assert.deepEqual(await outbox.counts(), { pending: 0, processing: 0, failed: 0 });
});

test("the same source identity uses distinct operation IDs across banks", async () => {
  const dir = await root();
  const outbox = new RetainOutbox({ rootDir: dir });
  const first = await outbox.enqueue({ identity: "same-turn", bankId: "primary", item: { content: "fact" } });
  const second = await outbox.enqueue({ identity: "same-turn", bankId: "shadow", item: { content: "fact" } });
  assert.notEqual(first.operationId, second.operationId);
  assert.deepEqual(await outbox.counts(), { pending: 2, processing: 0, failed: 0 });
});

test("two workers atomically claim jobs without duplicate retain", async () => {
  const dir = await root();
  const first = new RetainOutbox({ rootDir: dir, pollIntervalMs: 1 });
  const second = new RetainOutbox({ rootDir: dir, pollIntervalMs: 1 });
  for (let index = 0; index < 20; index++) {
    await first.enqueue({ identity: `turn:${index}`, bankId: "bank", item: { content: `fact-${index}` } });
  }
  const fake = new FakeOperations();
  await Promise.all([first.drain(fake), second.drain(fake)]);
  assert.equal(fake.retained.length, 20);
  assert.equal(new Set(fake.retained).size, 20);
  assert.deepEqual(await first.counts(), { pending: 0, processing: 0, failed: 0 });
});

test("claiming an old pending job starts a fresh processing lease", async () => {
  const dir = await root();
  const first = new RetainOutbox({ rootDir: dir, staleClaimMs: 100 });
  const second = new RetainOutbox({ rootDir: dir, staleClaimMs: 100 });
  const job = await first.enqueue({ identity: "old-pending", bankId: "bank", item: { content: "fact" } });
  const pendingPath = join(dir, "pending", `${job.id}.json`);
  const old = new Date(Date.now() - 1_000);
  await utimes(pendingPath, old, old);

  let markRetained!: () => void;
  let releaseRetain!: () => void;
  const retained = new Promise<void>((resolve) => { markRetained = resolve; });
  const release = new Promise<void>((resolve) => { releaseRetain = resolve; });
  const blocking: RetainOperations = {
    retain: async () => {
      markRetained();
      await release;
      return {};
    },
    operationStatus: async () => ({ status: "completed" }),
  };

  const draining = first.drain(blocking);
  await retained;
  const during = await second.counts();
  releaseRetain();
  let drainError: unknown;
  try {
    await draining;
  } catch (error) {
    drainError = error;
  }

  assert.deepEqual(during, { pending: 0, processing: 1, failed: 0 });
  assert.ifError(drainError);
  assert.deepEqual(await first.counts(), { pending: 0, processing: 0, failed: 0 });
});

test("stale processing jobs return to pending after a process crash", async () => {
  const dir = await root();
  let now = Date.now();
  const outbox = new RetainOutbox({ rootDir: dir, pollIntervalMs: 1, staleClaimMs: 100, clock: () => now });
  const job = await outbox.enqueue({ identity: "crashed", bankId: "bank", item: { content: "fact" } });
  const pending = join(dir, "pending", `${job.id}.json`);
  const exitedPid = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const processing = join(dir, "processing", `${job.id}-${exitedPid}-${randomUUID()}.json`);
  await rename(pending, processing);
  await utimes(processing, new Date(now - 1_000), new Date(now - 1_000));
  now += 1_000;
  assert.equal(await outbox.recoverStaleClaims(), 1);
  assert.deepEqual((await readdir(join(dir, "pending"))).filter((name) => name.endsWith(".json")), [`${job.id}.json`]);
});

test("cancelling an active drain returns its claim to pending", async () => {
  const dir = await root();
  const outbox = new RetainOutbox({ rootDir: dir, pollIntervalMs: 5, operationTimeoutMs: 10_000 });
  await outbox.enqueue({ identity: "cancel", bankId: "bank", item: { content: "fact" } });
  const pending: RetainOperations = {
    retain: async () => ({}),
    operationStatus: async () => ({ status: "pending" }),
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("shutdown")), 20);
  assert.deepEqual(await outbox.drain(pending, { signal: controller.signal }), { completed: 0, deferred: 1, failed: 0 });
  assert.deepEqual(await outbox.counts(), { pending: 1, processing: 0, failed: 0 });
});

test("failed retain is deferred without losing the job", async () => {
  const dir = await root();
  const outbox = new RetainOutbox({ rootDir: dir, pollIntervalMs: 1 });
  await outbox.enqueue({ identity: "retry", bankId: "bank", item: { content: "fact" } });
  const failing: RetainOperations = {
    retain: async () => { throw new Error("offline"); },
    operationStatus: async () => ({ status: "pending" }),
  };
  assert.deepEqual(await outbox.drain(failing), { completed: 0, deferred: 1, failed: 0 });
  assert.deepEqual(await outbox.counts(), { pending: 1, processing: 0, failed: 0 });
});
