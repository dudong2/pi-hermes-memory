import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CuratorStore } from "../../src/curator/store.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { CuratorObserver } from "../../src/curator/observer.js";
import { removeUnusedSkills } from "../../src/curator/removal.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const POLICY = { inactivityDays: 10, minimumObservationDays: 14, creationGraceDays: 7, modificationGraceDays: 3, adoptionGraceDays: 5, maxObservationAgeDays: 2 };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-remove-"));
  const skillRoot = path.join(root, "skills");
  const curator = new CuratorStore({ agentRoot: root, now: () => NOW });
  cleanup.push(async () => { curator.close(); await fs.rm(root, { recursive: true, force: true }); });
  // A closed Pi process, not a mocked liveness exemption, produces the evidence.
  const code = `
    import { CuratorStore } from './src/curator/store.ts';
    import { SkillStore } from './src/store/skill-store.ts';
    import { CuratorObserver } from './src/curator/observer.ts';
    const root = ${JSON.stringify(root)};
    let now = new Date('2026-09-05T00:00:00.000Z');
    const curator = new CuratorStore({ agentRoot: root, now: () => now });
    const skills = new SkillStore({ globalSkillsDir: root + '/skills', piGlobalSkillsDir: root + '/external', curator });
    const created = await skills.create('unused-removal', 'Unused removal workflow', '## Procedure\\n1. Inspect metadata', 'global');
    if (!created.success) throw new Error('fixture creation failed');
    const observer = new CuratorObserver(curator, () => [{ scope: 'global', path: root + '/skills' }]);
    await observer.start('closed-child-session');
    now = new Date('2026-10-15T00:00:00.000Z');
    await observer.close();
    curator.close();
  `;
  await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 15000 });
  const roots = [{ scope: "global" as const, path: skillRoot }];
  const skillPath = path.join(skillRoot, "unused-removal", "SKILL.md");
  const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external"), curator });
  return { root, curator, roots, skillRoot, skillPath, skills,
    remove: (policy: unknown = POLICY) => removeUnusedSkills({ curator, roots, policy, now: NOW }),
  };
}

describe("Curator quiet conditional removal", () => {
  it("removes a verified unused skill without retaining a deletion record", async () => {
    const f = await fixture();
    const result = await f.remove();
    assert.equal(result.removed, 1);
    assert.equal(result.failed, 0);
    await assert.rejects(fs.stat(f.skillPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.dirname(f.skillPath)), { code: "ENOENT" });
    const archive = path.join(f.root, "pi-hermes-memory", "curator", "archive", "global", "unused-removal");
    const entries = await fs.readdir(archive);
    assert.equal(entries.length, 1);
    assert.match(await fs.readFile(path.join(archive, entries[0], "SKILL.md"), "utf8"), /Unused removal workflow/);
    assert.deepEqual(f.curator.list(), []);
    assert.deepEqual(f.curator.activities(), []);
    assert.equal(JSON.stringify(result).includes("unused-removal"), false);
  });

  it("holds missing policy and pinned skills", async () => {
    const f = await fixture();
    assert.equal((await f.remove(null)).removed, 0);
    assert.equal((await f.remove({ ...POLICY, pinnedSkillIds: ["global:unused-removal"] })).removed, 0);
    assert.ok(await fs.stat(f.skillPath));
  });

  it("protects live session caches even after a run closes", async () => {
    const f = await fixture();
    const observer = new CuratorObserver(f.curator, () => f.roots);
    await observer.start("live-parent-session");
    await observer.close();
    assert.equal((await f.remove()).removed, 0);
    assert.ok(await fs.stat(f.skillPath));
  });

  it("does not remove a manually created or replaced generation", async () => {
    const f = await fixture();
    await f.skills.delete("global:unused-removal");
    const plain = new SkillStore({ globalSkillsDir: f.skillRoot, piGlobalSkillsDir: path.join(f.root, "external") });
    await plain.create("unused-removal", "Unused removal workflow", "## Procedure\n1. Inspect metadata", "global");
    assert.equal((await f.remove()).removed, 0);
    assert.ok(await fs.stat(f.skillPath));
  });

  it("does not remove bundles whose auxiliary use is not yet observed", async () => {
    const f = await fixture();
    const asset = path.join(path.dirname(f.skillPath), "owned-but-unobserved.txt");
    await fs.writeFile(asset, "preserve uncertain auxiliary content");
    assert.equal((await f.remove()).removed, 0);
    assert.equal(await fs.readFile(asset, "utf8"), "preserve uncertain auxiliary content");
    assert.ok(await fs.stat(f.skillPath));
  });

  it("does not follow symbolic links outside a managed directory", async () => {
    const f = await fixture();
    const external = path.join(f.root, "external-data");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "keep.txt"), "keep");
    await fs.symlink(external, path.join(path.dirname(f.skillPath), "linked"));
    assert.equal((await f.remove()).removed, 0);
    assert.equal(await fs.readFile(path.join(external, "keep.txt"), "utf8"), "keep");
  });

  it("protects a resource cache even without an observation run", async () => {
    const f = await fixture();
    f.curator.registerCacheOwner();
    assert.equal((await f.remove()).removed, 0);
    assert.ok(await fs.stat(f.skillPath));
  });

  it("holds successful edits that race with a previous plan", async () => {
    const f = await fixture();
    const original = f.curator.withMutation.bind(f.curator);
    let changed = false;
    f.curator.withMutation = async (roots, action) => {
      if (!changed) {
        changed = true;
        f.curator.withMutation = original;
        await f.skills.patch("global:unused-removal", "Procedure", "1. Newly edited procedure");
      }
      return original(roots, action);
    };
    assert.equal((await f.remove()).removed, 0);
    assert.match(await fs.readFile(f.skillPath, "utf8"), /Newly edited procedure/);
  });

  it("does not touch files if revoking deletion authority fails", async () => {
    const f = await fixture();
    f.curator.forgetGeneration = () => { throw new Error("recording failure"); };
    const before = await fs.readFile(f.skillPath);
    const result = await f.remove();
    assert.equal(result.removed, 0);
    assert.equal(result.failed, 1);
    assert.deepEqual(await fs.readFile(f.skillPath), before);
  });

  it("does not delete content changed after revocation and never resumes stale intent", async () => {
    const f = await fixture();
    const original = f.curator.forgetGeneration.bind(f.curator);
    f.curator.forgetGeneration = (record) => {
      const forgotten = original(record);
      writeFileSync(f.skillPath, readFileSync(f.skillPath, "utf8") + "\nNew content after revocation");
      return forgotten;
    };
    assert.equal((await f.remove()).removed, 0);
    assert.match(await fs.readFile(f.skillPath, "utf8"), /New content after revocation/);
    assert.deepEqual(f.curator.list(), []);
    assert.equal((await f.remove()).removed, 0);
    assert.ok(await fs.stat(f.skillPath));
  });

  it("does not remove hardlinked skills", async () => {
    const f = await fixture();
    const linked = path.join(f.root, "keep-linked.md");
    await fs.link(f.skillPath, linked);
    assert.equal((await f.remove()).removed, 0);
    assert.ok(await fs.stat(linked));
  });

  it("revalidates pins inside the mutation lock", async () => {
    const f = await fixture();
    let calls = 0;
    const policy = () => ++calls === 1 ? POLICY : { ...POLICY, pinnedSkillIds: ["global:unused-removal"] };
    assert.equal((await f.remove(policy)).removed, 0);
    assert.ok(calls >= 2);
    assert.ok(await fs.stat(f.skillPath));
  });
});
