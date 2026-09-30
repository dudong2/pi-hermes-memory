import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillStore } from "../../src/store/skill-store.js";
import { CuratorStore } from "../../src/curator/store.js";
import { inventorySkills } from "../../src/curator/inventory.js";

const fixtures: { root: string; curator: CuratorStore }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.curator.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-"));
  const globalRoot = path.join(root, "global", "skills");
  const projectRoot = path.join(root, "projects", "demo", "skills");
  const curator = new CuratorStore({ agentRoot: root });
  fixtures.push({ root, curator });
  const store = new SkillStore({
    globalSkillsDir: globalRoot,
    piGlobalSkillsDir: path.join(root, "external"),
    projectSkillsDir: projectRoot,
    projectName: "demo",
    legacySkillsDir: path.join(root, "legacy"),
    migrationSentinelPath: path.join(root, "sentinel"),
    curator,
  });
  const roots = [
    { scope: "global" as const, path: globalRoot },
    { scope: "project" as const, path: projectRoot, projectName: "demo" },
  ];
  return { root, globalRoot, projectRoot, curator, store, roots };
}

describe("Curator creation ledger", () => {
  it("does not create a database until a successful mutation", async () => {
    const f = await fixture();
    assert.deepEqual(f.curator.list(), []);
    await assert.rejects(fs.stat(f.curator.dbPath), { code: "ENOENT" });
    assert.equal((await f.store.create("", "description", "body", "global")).success, false);
    assert.deepEqual(f.curator.list(), []);
  });

  it("records successful creation with a generation, not failed creation or listing", async () => {
    const f = await fixture();
    const result = await f.store.create("bounded-procedure", "A repeatable procedure", "## Procedure\n1. Check", "global");
    assert.equal(result.success, true);
    const records = f.curator.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].skillId, result.skillId);
    assert.match(records[0].generationId, /^[0-9a-f-]{36}$/);
    assert.equal(records[0].state, "active");
    assert.equal((await f.store.create("bounded-procedure", "A repeatable procedure", "body", "global")).success, false);
    await f.store.loadIndex();
    await f.store.loadSkill(result.skillId!);
    assert.deepEqual(f.curator.list(), records);
    const report = await inventorySkills({ roots: f.roots, curator: f.curator });
    assert.equal(report.skills[0].source, "creation-boundary");
    assert.equal(report.skills[0].generation, "verified");
    assert.equal(report.skills[0].cleanupEligible, false);
    assert.equal(JSON.stringify(report).includes("## Procedure"), false);
    assert.equal(JSON.stringify(records).includes(f.root), false);
  });

  it("does not enroll externally written skills through view or modification", async () => {
    const f = await fixture();
    const unmanaged = new SkillStore({ globalSkillsDir: f.globalRoot, piGlobalSkillsDir: path.join(f.root, "external") });
    const result = await unmanaged.create("external-procedure", "External", "## Procedure\n1. Original", "global");
    await f.store.loadSkill(result.skillId!);
    assert.equal((await f.store.patch(result.skillId!, "Procedure", "1. Updated")).success, true);
    assert.deepEqual(f.curator.list(), []);
    const report = await inventorySkills({ roots: f.roots, curator: f.curator });
    assert.equal(report.skills[0].generation, "unverified");
  });

  it("keeps scopes separate and gives recreation a new generation", async () => {
    const f = await fixture();
    const first = await f.store.create("same-name", "Same", "body", "global");
    await f.store.create("same-name", "Same", "body", "project");
    const oldGeneration = f.curator.list().find((row) => row.skillId === first.skillId)!.generationId;
    assert.equal((await f.store.delete(first.skillId!)).success, true);
    assert.equal((await f.store.create("same-name", "Same", "body", "global")).success, true);
    const records = f.curator.list();
    assert.equal(records.filter((row) => row.state === "active").length, 2);
    assert.equal(records.some((row) => row.generationId === oldGeneration), false);
    assert.equal(records.length, 2);
    assert.notEqual(records.find((row) => row.state === "active" && row.skillId === first.skillId)!.generationId, oldGeneration);
  });

  it("preserves a generation through edits and verified scope moves", async () => {
    const f = await fixture();
    const first = await f.store.create("movable", "Movable", "## Procedure\n1. Original", "project");
    const before = f.curator.list()[0];
    await f.store.patch(first.skillId!, "Procedure", "1. Updated");
    await f.store.edit(first.skillId!, "Updated description", "## Procedure\n1. Final");
    const edited = f.curator.list()[0];
    assert.equal(edited.generationId, before.generationId);
    assert.notEqual(edited.contentHash, before.contentHash);
    assert.ok(edited.lastActivityAt);
    const moved = await f.store.move(first.skillId!, "global");
    assert.equal(moved.success, true);
    const record = f.curator.list()[0];
    assert.equal(record.generationId, before.generationId);
    assert.equal(record.skillId, moved.skillId);
    assert.equal(record.scope, "global");
    assert.equal((await inventorySkills({ roots: f.roots, curator: f.curator })).skills[0].generation, "verified");
  });

  it("does not turn successful file creation into failure when recording fails", async () => {
    const f = await fixture();
    f.curator.record = async () => { throw new Error("simulated ledger failure"); };
    const result = await f.store.create("unrecorded", "Unrecorded", "body", "global");
    assert.equal(result.success, true);
    assert.ok(await fs.stat(result.path!));
    assert.deepEqual(f.curator.list(), []);
    const report = await inventorySkills({ roots: f.roots, curator: f.curator });
    assert.equal(report.skills[0].generation, "unverified");
    assert.equal(report.skills[0].cleanupEligible, false);
    assert.ok(report.warnings.includes("ledger-record-failed"));
  });

  it("does not attach an old generation after identical recreation with failed recording", async () => {
    const f = await fixture();
    const original = await f.store.create("recreated", "Same", "body", "global");
    const old = f.curator.list()[0];
    f.curator.record = async () => { throw new Error("simulated ledger failure"); };
    await f.store.delete(original.skillId!);
    await f.store.create("recreated", "Same", "body", "global");
    f.curator.close();
    const reopened = new CuratorStore({ agentRoot: f.root });
    try {
      assert.equal(reopened.list()[0].generationId, old.generationId);
      const report = await inventorySkills({ roots: f.roots, curator: reopened });
      assert.equal(report.skills[0].generation, "unverified");
    } finally {
      reopened.close();
    }
  });

  it("does not overwrite unknown provenance when a marker is copied", async () => {
    const f = await fixture();
    const first = await f.store.create("copied", "Copied", "body", "global");
    const bytes = await fs.readFile(first.path!);
    await fs.unlink(first.path!);
    await fs.writeFile(first.path!, bytes);
    const report = await inventorySkills({ roots: f.roots, curator: f.curator });
    assert.equal(report.skills[0].generation, "unverified");
  });

  it("ignores symlink directories and leaves skill bytes and timestamps unchanged", async () => {
    const f = await fixture();
    const result = await f.store.create("unchanged", "Unchanged", "body", "global");
    await fs.writeFile(path.join(path.dirname(result.path!), "asset.txt"), "asset");
    await fs.symlink(path.dirname(result.path!), path.join(f.globalRoot, "alias"));
    const beforeBytes = await fs.readFile(result.path!);
    const beforeStat = await fs.stat(result.path!);
    const report = await inventorySkills({ roots: f.roots, curator: f.curator });
    assert.equal(report.skills.length, 1);
    assert.ok(report.warnings.includes("symlink-skipped"));
    assert.deepEqual(await fs.readFile(result.path!), beforeBytes);
    assert.equal((await fs.stat(result.path!)).mtimeMs, beforeStat.mtimeMs);
    assert.equal(await fs.readFile(path.join(path.dirname(result.path!), "asset.txt"), "utf8"), "asset");
  });

  it("does not replay a creation event or count a no-op move as activity", async () => {
    const f = await fixture();
    const result = await f.store.create("idempotent", "Idempotent", "body", "global");
    const before = f.curator.list();
    await f.curator.record({ kind: "create", before: null, after: before[0] });
    await f.store.move(result.skillId!, "global");
    assert.deepEqual(f.curator.list(), before);
  });

  it("tracks configured roots outside the agent directory without persisting absolute paths", async () => {
    const f = await fixture();
    const curator = new CuratorStore({ agentRoot: path.join(f.root, "separate-agent") });
    const skills = new SkillStore({ globalSkillsDir: f.globalRoot, piGlobalSkillsDir: path.join(f.root, "external"), curator });
    try {
      assert.equal((await skills.create("configured-root", "Configured root", "body", "global")).success, true);
      const records = curator.list();
      assert.equal(records[0].rootRelativePath, "@configured");
      assert.equal(JSON.stringify(records).includes(f.root), false);
      const report = await inventorySkills({ roots: f.roots, curator });
      assert.equal(report.skills[0].generation, "verified");
    } finally {
      curator.close();
    }
  });

  it("freezes project identity across resource discovery rebinding", async () => {
    const f = await fixture();
    const original = f.curator.withMutation.bind(f.curator);
    f.curator.withMutation = (roots, operation) => original(roots, async () => {
      f.store.setProjectContext("other", path.join(f.root, "projects", "other", "skills"));
      return operation();
    });
    const result = await f.store.create("bound", "Bound", "body", "project");
    assert.equal(result.skillId, "project:demo:bound");
    assert.equal(f.curator.list()[0].skillId, "project:demo:bound");
    assert.equal(result.path, path.join(f.projectRoot, "bound", "SKILL.md"));
  });

  it("leaves a corrupt ledger untouched and keeps new creation successful but unmanaged", async () => {
    const f = await fixture();
    await f.store.create("before-corruption", "Before corruption", "body", "global");
    f.curator.close();
    const corrupted = Buffer.from("not a SQLite database");
    await fs.writeFile(f.curator.dbPath, corrupted);
    const result = await f.store.create("after-corruption", "After corruption", "body", "global");
    assert.equal(result.success, true);
    const report = await inventorySkills({ roots: f.roots, curator: f.curator });
    assert.equal(report.partial, true);
    assert.ok(report.warnings.includes("ledger-unavailable"));
    assert.ok(report.skills.every((row) => row.generation === "unverified" && !row.cleanupEligible));
    assert.deepEqual(await fs.readFile(f.curator.dbPath), corrupted);
  });

  it("does not write through a symlinked ledger file", async () => {
    const f = await fixture();
    await f.store.create("original-ledger", "Original ledger", "body", "global");
    f.curator.close();
    const target = path.join(f.root, "untouched.db");
    const bytes = Buffer.from("private unrelated file");
    await fs.writeFile(target, bytes);
    await fs.unlink(f.curator.dbPath);
    await fs.symlink(target, f.curator.dbPath);
    assert.equal((await f.store.create("after-link", "After link", "body", "global")).success, true);
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.equal((await inventorySkills({ roots: f.roots, curator: f.curator })).partial, true);
  });

  it("rejects redirected storage before creating files or changing directory permissions", async () => {
    const f = await fixture();
    const target = path.join(f.root, "unrelated-directory");
    await fs.mkdir(target, { mode: 0o755 });
    const mode = (await fs.stat(target)).mode;
    await fs.mkdir(path.dirname(path.dirname(f.curator.dbPath)), { recursive: true });
    await fs.symlink(target, path.dirname(f.curator.dbPath));
    await assert.rejects(f.store.create("blocked", "Blocked", "body", "global"), /unsafe-curator-directory/);
    assert.deepEqual(await fs.readdir(target), []);
    assert.equal((await fs.stat(target)).mode, mode);
  });

  it("does not follow skill-file symlinks or grant rights to hardlinked copies", async () => {
    const f = await fixture();
    const result = await f.store.create("linked", "Linked", "body", "global");
    await fs.link(result.path!, path.join(f.root, "copy.md"));
    await fs.mkdir(path.join(f.globalRoot, "symlinked"));
    await fs.symlink(result.path!, path.join(f.globalRoot, "symlinked", "SKILL.md"));
    const report = await inventorySkills({ roots: f.roots, curator: f.curator });
    assert.equal(report.skills.length, 0);
    assert.equal(report.partial, true);
    assert.equal(await fs.readFile(path.join(f.root, "copy.md"), "utf8"), await fs.readFile(result.path!, "utf8"));
  });

  it("uses private ledger permissions and survives process-local reopen", async () => {
    const f = await fixture();
    await f.store.create("private", "Private", "body", "global");
    const before = f.curator.list();
    assert.equal((await fs.stat(f.curator.dbPath)).mode & 0o777, 0o600);
    f.curator.close();
    assert.deepEqual(f.curator.list(), before);
  });
});
