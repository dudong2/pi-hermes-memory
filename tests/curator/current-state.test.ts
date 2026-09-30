import { it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { CuratorStore } from "../../src/curator/store.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { loadBetterSqlite3 } from "../../src/store/sqlite-native.js";
import { processMayBeAlive } from "../../src/curator/process-owner.js";

interface Database {
  exec(sql: string): void;
  prepare(sql: string): { all(): { name: string }[] };
  close(): void;
}

it("keeps no audit table or deleted generation history after migration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-state-"));
  const curator = new CuratorStore({ agentRoot: root });
  const skills = new SkillStore({ globalSkillsDir: path.join(root, "skills"), piGlobalSkillsDir: path.join(root, "external"), curator });
  const Ctor = loadBetterSqlite3({ requireImpl: createRequire(import.meta.url) }) as new (file: string, options?: { readonly: boolean }) => Database;
  try {
    const created = await skills.create("current-state", "Current state only", "body", "global");
    curator.close();
    const old = new Ctor(curator.dbPath);
    try {
      old.exec("CREATE TABLE operations (id INTEGER PRIMARY KEY); INSERT INTO operations VALUES (1); UPDATE curator_metadata SET value = '2' WHERE key = 'schema_version'");
    } finally { old.close(); }
    await skills.patch(created.skillId!, "Procedure", "1. Updated");
    await skills.delete(created.skillId!);
    assert.deepEqual(curator.list(), []);
    curator.close();
    const db = new Ctor(curator.dbPath, { readonly: true });
    try {
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name = 'operations'").all(), []);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%deletion%' OR name LIKE '%archive%'").all(), []);
    } finally { db.close(); }
  } finally { curator.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("uses the shared mutation boundary even when provenance tracking is disabled", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-lock-only-"));
  let locked = 0;
  const skills = new SkillStore({
    globalSkillsDir: path.join(root, "skills"), piGlobalSkillsDir: path.join(root, "external"),
    mutationLock: { withMutation: async (_roots, action) => { locked++; return action(); } },
  });
  try {
    const created = await skills.create("lock-only", "Lock only", "body", "global");
    assert.equal(created.success, true);
    await skills.patch(created.skillId!, "Procedure", "1. Update");
    await skills.delete(created.skillId!);
    assert.equal(locked, 3);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("protects uncertain process ownership and never treats a probe failure as exit", () => {
  assert.equal(processMayBeAlive({}), true);
  assert.equal(processMayBeAlive({ ownerPid: -1 }), true);
  assert.equal(processMayBeAlive({ ownerPid: process.pid }), true);
});
