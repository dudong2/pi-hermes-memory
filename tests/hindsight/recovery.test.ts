import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, utimes } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { RetainOutbox } from "../../src/hindsight/outbox.js";
import { withQueueMutation } from "../../src/hindsight/queue-lock.js";
import { tempRoot } from "../scope/fixtures.js";

test("unknown legacy claims remain durable rather than being recovered by age", async () => {
  const root = await tempRoot("outbox-legacy-owner-");
  const outbox = new RetainOutbox({ rootDir: root, staleClaimMs: 1 });
  const job = await outbox.enqueue({ identity: "legacy", bankId: "existing", item: { content: "preserve" } });
  const processing = join(root, "processing", job.id + ".json");
  await rename(join(root, "pending", job.id + ".json"), processing);
  const before = await readFile(processing);
  const old = new Date(Date.now() - 10000);
  await utimes(processing, old, old);
  assert.equal(await outbox.recoverStaleClaims(), 0);
  assert.deepEqual(await readFile(processing), before);
});

test("recovering an exited owner never overwrites an already pending generation", async () => {
  const root = await tempRoot("outbox-recovery-collision-");
  const outbox = new RetainOutbox({ rootDir: root, staleClaimMs: 1 });
  const job = await outbox.enqueue({ identity: "collision", bankId: "existing", item: { content: "preserve" } });
  const pending = join(root, "pending", job.id + ".json");
  const pid = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const processing = join(root, "processing", `${job.id}-${pid}-${randomUUID()}.json`);
  const { copyFile } = await import("node:fs/promises");
  await copyFile(pending, processing);
  const old = new Date(Date.now() - 10000);
  await utimes(processing, old, old);
  const before = await readFile(pending);
  assert.equal(await outbox.recoverStaleClaims(), 0);
  assert.deepEqual(await readFile(pending), before);
  assert.deepEqual(await readFile(processing), before);
});

test("a mutation failure is propagated once and cannot be replayed as lease contention", async () => {
  const root = await tempRoot("outbox-once-");
  await mkdir(join(root, "state"));
  let calls = 0;
  await assert.rejects(withQueueMutation(root, async () => {
    calls++;
    throw Object.assign(new Error("mutation failed"), { code: "SQLITE_BUSY" });
  }), /mutation failed/);
  assert.equal(calls, 1);
  assert.equal(await withQueueMutation(root, async () => 42), 42);
});
