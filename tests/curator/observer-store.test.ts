import { it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { loadBetterSqlite3 } from "../../src/store/sqlite-native.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { CuratorStore } from "../../src/curator/store.js";
import { CuratorObserver } from "../../src/curator/observer.js";

it("does not create an observation database when there are no managed skills", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-cold-observer-"));
  const curator = new CuratorStore({ agentRoot: root });
  const observer = new CuratorObserver(curator, () => []);
  try {
    await observer.start("empty-session");
    await observer.onInput({ text: "/skill:external" }, root);
    await observer.close();
    assert.deepEqual(curator.observations().runs, []);
    await assert.rejects(fs.stat(curator.dbPath), { code: "ENOENT" });
  } finally { curator.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("migrates a v1 ledger only on observation writes, without altering generations or skill bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-observer-migrate-"));
  const curator = new CuratorStore({ agentRoot: root });
  const skillRoot = path.join(root, "skills");
  const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external"), curator });
  const observer = new CuratorObserver(curator, () => [{ scope: "global", path: skillRoot }]);
  try {
    const created = await skills.create("legacy-ledger", "Legacy ledger workflow", "body", "global");
    const record = curator.list()[0];
    const bytes = await fs.readFile(created.path!);
    curator.close();
    const Ctor = loadBetterSqlite3({ requireImpl: createRequire(import.meta.url) }) as new (file: string) => { exec(sql: string): void; close(): void };
    const db = new Ctor(curator.dbPath);
    try { db.exec("DROP TABLE skill_activity; DROP TABLE observation_gaps; DROP TABLE observation_runs; UPDATE curator_metadata SET value = '1' WHERE key = 'schema_version'"); }
    finally { db.close(); }
    const legacyBytes = await fs.readFile(curator.dbPath);
    assert.deepEqual(curator.list(), [record]);
    assert.deepEqual(curator.observations().runs, []);
    assert.deepEqual(await fs.readFile(curator.dbPath), legacyBytes);
    await observer.start("migration-session");
    const call = { toolName: "read", toolCallId: "migration-read", input: { path: created.path } };
    await observer.onToolCall(call, root);
    await observer.onToolResult({ ...call, isError: false, content: [{ type: "text", text: "read result" }] }, root);
    assert.equal(curator.list()[0].generationId, record.generationId);
    assert.equal(curator.activities().length, 1);
    assert.equal(curator.observations().runs.length, 1);
    assert.deepEqual(await fs.readFile(created.path!), bytes);
  } finally { await observer.close(); curator.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("retains an unclosed run after a crash instead of inferring a healthy interval", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-observer-crash-"));
  const curator = new CuratorStore({ agentRoot: root });
  const skillRoot = path.join(root, "skills");
  const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external"), curator });
  const abandoned = new CuratorObserver(curator, () => [{ scope: "global", path: skillRoot }]);
  let resumed: CuratorObserver | undefined;
  try {
    await skills.create("crash-aware", "Crash-aware workflow", "body", "global");
    await abandoned.start("abandoned-session");
    const original = curator.observations().runs[0];
    curator.close(); // Simulate process death without an observer shutdown event.
    resumed = new CuratorObserver(curator, () => [{ scope: "global", path: skillRoot }]);
    await resumed.start("new-session");
    await resumed.close();
    const runs = curator.observations().runs;
    assert.equal(runs.find((run) => run.runId === original.runId)!.endedAt, null);
    assert.equal(runs.find((run) => run.runId === original.runId)!.state, "open");
    assert.equal(runs.filter((run) => run.state === "closed").length, 1);
    assert.equal(curator.observations().allPathsObserved, false);
  } finally { await resumed?.close(); await abandoned.close(); curator.close(); await fs.rm(root, { recursive: true, force: true }); }
});
