import { it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { loadBetterSqlite3 } from "../../src/store/sqlite-native.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { CuratorStore } from "../../src/curator/store.js";
import { inventorySkills } from "../../src/curator/inventory.js";

interface TestDatabase {
  exec(sql: string): void;
  close(): void;
}

it("does not reinterpret or rebuild a future-version ledger", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-schema-"));
  const curator = new CuratorStore({ agentRoot: root });
  const skillRoot = path.join(root, "skills");
  const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external"), curator });
  try {
    assert.equal((await skills.create("versioned", "Versioned", "body", "global")).success, true);
    curator.close();
    const Ctor = loadBetterSqlite3({ requireImpl: createRequire(import.meta.url) }) as new (file: string) => TestDatabase;
    const db = new Ctor(curator.dbPath);
    try { db.exec("UPDATE curator_metadata SET value = '999' WHERE key = 'schema_version'"); }
    finally { db.close(); }
    const before = await fs.readFile(curator.dbPath);
    assert.throws(() => curator.list(), /unsupported-curator-schema/);
    const report = await inventorySkills({ roots: [{ scope: "global", path: skillRoot }], curator });
    assert.equal(report.partial, true);
    assert.ok(report.warnings.includes("ledger-unavailable"));
    assert.equal(report.skills[0].generation, "unverified");
    assert.equal((await skills.create("after-upgrade", "After upgrade", "body", "global")).success, true);
    assert.deepEqual(await fs.readFile(curator.dbPath), before);
  } finally {
    curator.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
