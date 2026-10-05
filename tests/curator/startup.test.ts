import { afterEach, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CuratorStore } from "../../src/curator/store.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { runCuratorCycle } from "../../src/curator/runner.js";
import { registerCuratorStartup } from "../../src/curator/startup.ts";

const day = 86_400_000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "curator-startup-"));
  const curator = new CuratorStore({ agentRoot: root, now: () => new Date(Date.now() - 20 * day) });
  cleanups.push(async () => { curator.close(); await fs.rm(root, { recursive: true, force: true }); });
  const configPath = path.join(root, "hermes-memory-config.json");
  const policy = { inactivityDays: 14, minimumObservationDays: 14, creationGraceDays: 14,
    modificationGraceDays: 14, adoptionGraceDays: 14, maxObservationAgeDays: 2 };
  await fs.writeFile(configPath, JSON.stringify({ curatorPolicy: policy, curatorPaused: true }));
  const skills = new SkillStore({ curator, globalSkillsDir: path.join(root, "pi-hermes-memory/skills"),
    piGlobalSkillsDir: path.join(root, "external") });
  assert.equal((await skills.create("startup-eligible", "Reusable", "## Procedure\n1. Inspect", "global")).success, true);
  const file = path.join(root, "pi-hermes-memory/skills/startup-eligible/SKILL.md");
  // A live owner is deliberately left in place: reopening a cached session may
  // see a stale skill until it reloads, but must never grant deletion authority.
  curator.registerCacheOwner();
  curator.beginObservation(randomUUID(), "a".repeat(64));
  return { root, curator, file, configPath, policy };
}

it("runs the full startup preflight while paused, then removes only when unpaused", async () => {
  const f = await fixture();
  const first = await runCuratorCycle({ agentRoot: f.root, mode: "startup" });
  assert.equal(first.removed, 0);
  assert.equal(first.eligible, 1);
  assert.ok(await fs.stat(f.file));
  assert.equal(f.curator.list().length, 1);
  await fs.writeFile(f.configPath, JSON.stringify({ curatorPolicy: f.policy, curatorPaused: false }));
  const next = await runCuratorCycle({ agentRoot: f.root, mode: "startup" });
  assert.equal(next.removed, 1);
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
  assert.equal(f.curator.list().length, 0);
});

it("does not preflight or remove bundles with unobserved auxiliary files", async () => {
  const f = await fixture();
  const asset = path.join(path.dirname(f.file), "reference.txt");
  await fs.writeFile(asset, "keep this asset");
  const paused = await runCuratorCycle({ agentRoot: f.root, mode: "startup" });
  assert.equal(paused.eligible, 0);
  await fs.writeFile(f.configPath, JSON.stringify({ curatorPolicy: f.policy, curatorPaused: false }));
  assert.equal((await runCuratorCycle({ agentRoot: f.root, mode: "startup" })).removed, 0);
  assert.equal(await fs.readFile(asset, "utf8"), "keep this asset");
  assert.ok(await fs.stat(f.file));
});

it("runs only at process startup, before resources discovery", async () => {
  const sequence: string[] = [];
  const handlers: Record<string, ((event: { reason?: string }) => Promise<void>)[]> = {};
  const pi = { on: (name: string, handler: (event: { reason?: string }) => Promise<void>) => {
    (handlers[name] ??= []).push(handler);
  } };
  registerCuratorStartup(pi as never, "/unused", async () => { sequence.push("inspect"); });
  await handlers.session_start[0]({ reason: "reload" });
  assert.equal(sequence.length, 0);
  await handlers.session_start[0]({ reason: "startup" });
  sequence.push("resources_discover");
  assert.deepEqual(sequence, ["inspect", "resources_discover"]);
});
