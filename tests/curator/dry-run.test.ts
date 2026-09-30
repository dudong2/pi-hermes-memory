import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CuratorStore } from "../../src/curator/store.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { CuratorObserver } from "../../src/curator/observer.js";
import { dryRunCurator } from "../../src/curator/dry-run.js";
import type { CuratorPolicyConfig } from "../../src/curator/policy.js";

const NOW = new Date("2026-10-15T00:00:00.000Z");
const POLICY: CuratorPolicyConfig = { inactivityDays: 10, minimumObservationDays: 14, creationGraceDays: 7, modificationGraceDays: 3, adoptionGraceDays: 5, maxObservationAgeDays: 2 };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-dry-run-"));
  let now = new Date(NOW.getTime() - 40 * 86_400_000);
  const curator = new CuratorStore({ agentRoot: root, now: () => now });
  const globalRoot = path.join(root, "skills");
  const roots = [{ scope: "global" as const, path: globalRoot }];
  const skills = new SkillStore({ globalSkillsDir: globalRoot, piGlobalSkillsDir: path.join(root, "external"), curator });
  const created = await skills.create("dry-run-fixture", "Bounded dry-run fixture", "## Procedure\n1. Inspect metadata", "global");
  assert.equal(created.success, true);
  await fs.writeFile(path.join(path.dirname(created.path!), "asset.bin"), Buffer.from([0, 1, 2, 255]));
  const observer = new CuratorObserver(curator, () => roots);
  await observer.start("policy-fixture-session");
  now = NOW;
  await observer.close();
  cleanup.push(async () => { await observer.close(); curator.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, curator, roots, created, observer, skills,
    evaluate: (policy: unknown = POLICY) => dryRunCurator({ roots, curator, policy, now: NOW }),
  };
}

describe("Curator read-only dry-run", () => {
  it("preserves skill, asset, ledger bytes and timestamps while reporting scoped candidates", async () => {
    const f = await fixture();
    const files = [f.created.path!, path.join(path.dirname(f.created.path!), "asset.bin"), f.curator.dbPath];
    const before = await Promise.all(files.map(async (file) => ({ bytes: await fs.readFile(file), stat: await fs.stat(file) })));
    const report = await f.evaluate();
    assert.equal(report.candidateCount, 1);
    assert.equal(report.dryRun, true);
    assert.equal(report.automaticArchiving, false);
    assert.equal(report.decisions[0].cleanupEligible, false);
    assert.equal(JSON.stringify(report).includes("## Procedure"), false);
    assert.equal(JSON.stringify(report).includes(f.root), false);
    for (let i = 0; i < files.length; i++) {
      assert.deepEqual(await fs.readFile(files[i]), before[i].bytes);
      assert.equal((await fs.stat(files[i])).mtimeMs, before[i].stat.mtimeMs);
      assert.equal((await fs.stat(files[i])).ctimeMs, before[i].stat.ctimeMs);
    }
  });

  it("holds pinned skills and defaults to no policy", async () => {
    const f = await fixture();
    assert.equal((await f.evaluate({ ...POLICY, pinnedSkillIds: [f.created.skillId] })).candidateCount, 0);
    const report = await dryRunCurator({ roots: f.roots, curator: f.curator, now: NOW });
    assert.ok(report.decisions[0].reasons.includes("policy-not-configured"));
  });

  it("holds every known root when session-cache protection is unresolved", async () => {
    const f = await fixture();
    await f.observer.start("active-session");
    const report = await f.evaluate();
    assert.equal(report.candidateCount, 0);
    assert.ok(report.decisions[0].reasons.includes("in-use"));
    assert.ok(report.decisions[0].reasons.includes("observation-open"));
  });

  it("uses fresh activity from a consistent metadata snapshot", async () => {
    const f = await fixture();
    const original = f.curator.readSnapshot.bind(f.curator);
    f.curator.readSnapshot = () => {
      const snapshot = original();
      snapshot.records[0].lastActivityAt = NOW.toISOString();
      return snapshot;
    };
    const report = await f.evaluate();
    assert.equal(report.candidateCount, 0);
    assert.ok(report.decisions[0].reasons.includes("recent-activity"));
  });

  it("does not apply an old filesystem verification to changed metadata", async () => {
    const f = await fixture();
    const original = f.curator.readSnapshot.bind(f.curator);
    f.curator.readSnapshot = () => {
      const snapshot = original();
      snapshot.records[0].contentHash = "0".repeat(64);
      return snapshot;
    };
    const report = await f.evaluate();
    assert.equal(report.candidateCount, 0);
    assert.ok(report.decisions[0].reasons.includes("unverified-generation"));
  });

  it("returns holds instead of hiding snapshot failures", async () => {
    const f = await fixture();
    f.curator.readSnapshot = () => { throw new Error("private details"); };
    const report = await f.evaluate();
    assert.equal(report.candidateCount, 0);
    assert.ok(report.warnings.includes("snapshot-unavailable"));
    assert.equal(JSON.stringify(report).includes("private details"), false);
  });
});
