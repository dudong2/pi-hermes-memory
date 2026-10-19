import assert from "node:assert/strict";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseManager } from "../../src/store/db.js";

test("startup integrity scan never runs quick_check on the main connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-integrity-"));
  const manager = new DatabaseManager(root);
  try {
    const database = manager.getDb();
    const prepare = database.prepare.bind(database);
    let mainThreadScans = 0;
    database.prepare = (sql) => {
      if (/^\s*PRAGMA\s+quick_check\b/i.test(sql)) mainThreadScans++;
      return prepare(sql);
    };
    await manager.waitForStartupIntegrityScan();
    assert.equal(mainThreadScans, 0, "a deferred synchronous scan still blocks Pi's main thread");
    assert.equal(manager.getLastRecovery(), null);
    assert.equal(database.prepare("SELECT 1 AS ok").get().ok, 1);
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("main-thread timers keep running while the startup scan completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-responsive-"));
  const manager = new DatabaseManager(root);
  let ticks = 0;
  const database = manager.getDb();
  const heartbeat = setInterval(() => { ticks++; }, 1);
  try {
    await manager.waitForStartupIntegrityScan();
    assert.ok(ticks > 0, "the scan must yield to Pi's event loop");
    assert.equal(database.prepare("SELECT 1 AS ok").get().ok, 1);
  } finally {
    clearInterval(heartbeat);
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closing and reopening does not let the old scan replace the new connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-reopen-"));
  const manager = new DatabaseManager(root);
  try {
    const original = manager.getDb();
    const oldScan = manager.waitForStartupIntegrityScan();
    // The scan timer was queued first; close while its worker is starting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    manager.close();
    const reopened = manager.getDb();
    assert.notEqual(reopened, original);
    await oldScan;
    await manager.waitForStartupIntegrityScan();
    assert.equal(manager.getDb(), reopened);
    assert.equal(manager.getLastRecovery(), null);
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a replaced database file invalidates a scan from the old connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-replaced-"));
  const manager = new DatabaseManager(root);
  try {
    manager.getDb();
    await rename(join(root, "sessions.db"), join(root, "old.db"));
    // No replacement exists: a late scan must not recover or create one.
    await manager.waitForStartupIntegrityScan();
    assert.equal(manager.getLastRecovery(), null);
  } finally {
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker open failures are not reported as database corruption", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-startup-worker-error-"));
  try {
    const worker = new Worker(new URL("../../src/store/startup-integrity-worker.cjs", import.meta.url), {
      workerData: { dbPath: join(root, "missing.db"), bun: false, dev: 0, ino: 0 },
      execArgv: [],
    });
    const result = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await new Promise((resolve) => worker.once("exit", resolve));
    assert.deepEqual(result, { status: "failed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
