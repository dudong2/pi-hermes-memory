import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { watch } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { CuratorStore } from "../../src/curator/store.js";
import { loadConfig } from "../../src/config.js";
import { readRunnerConfig, runCuratorCycle, runPeriodicCurator } from "../../src/curator/runner.js";

const execute = promisify(execFile);
const cwd = fileURLToPath(new URL("../../", import.meta.url));
const POLICY = { inactivityDays: 10, minimumObservationDays: 14, creationGraceDays: 7,
  modificationGraceDays: 3, adoptionGraceDays: 5, maxObservationAgeDays: 2 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(managed = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-runner-"));
  const curator = new CuratorStore({ agentRoot: root });
  cleanups.push(async () => { curator.close(); await fs.rm(root, { recursive: true, force: true }); });
  const configPath = path.join(root, "hermes-memory-config.json");
  const configure = (fields = {}) => fs.writeFile(configPath, JSON.stringify({ curatorPolicy: POLICY, ...fields }));
  await configure();
  if (managed) {
    const code = `
      import { CuratorStore } from './src/curator/store.ts';
      import { SkillStore } from './src/store/skill-store.ts';
      import { CuratorObserver } from './src/curator/observer.ts';
      const root = ${JSON.stringify(root)};
      const end = Date.now();
      let now = new Date(end - 40 * 86400000);
      const curator = new CuratorStore({ agentRoot: root, now: () => now });
      const skills = new SkillStore({ globalSkillsDir: root + '/pi-hermes-memory/skills',
        piGlobalSkillsDir: root + '/external', projectSkillsDir: root + '/projects-memory/project-one/skills',
        projectName: 'project-one', curator });
      for (const scope of ['global', 'project']) {
        if (!(await skills.create('unused-' + scope, 'Reusable procedure', '## Procedure\\n1. Inspect', scope)).success) throw new Error('fixture');
      }
      const roots = [{ scope: 'global', path: skills.getGlobalSkillsDir() },
        { scope: 'project', projectName: 'project-one', path: skills.getProjectSkillsDir() }];
      const observer = new CuratorObserver(curator, () => roots);
      await observer.start('exited-owner');
      now = new Date(end);
      await observer.close();
      curator.close();
    `;
    await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd, env: { ...process.env, PI_CODING_AGENT_DIR: root }, timeout: 15000,
    });
  }
  const globalPath = path.join(root, "pi-hermes-memory/skills/unused-global/SKILL.md");
  const projectPath = path.join(root, "projects-memory/project-one/skills/unused-project/SKILL.md");
  return { root, curator, configPath, configure, globalPath, projectPath,
    cycle: () => runCuratorCycle({ agentRoot: root }),
    cli: (args: string[]) => execute(process.execPath, ["scripts/curator.mjs", ...args], {
      cwd, env: { ...process.env, PI_CODING_AGENT_DIR: root }, timeout: 15000,
    }),
  };
}

describe("Curator independent runner", () => {
  it("removes eligible global and known project skills without loading a Pi session", async () => {
    const f = await fixture();
    const result = await f.cycle();
    assert.equal(result.removed, 2);
    assert.equal(result.failed, 0);
    await assert.rejects(fs.stat(f.globalPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(f.projectPath), { code: "ENOENT" });
    assert.deepEqual(f.curator.list(), []);
  });

  it("creates no ledger, roots, or scheduler when there are no managed skills", async () => {
    const f = await fixture(false);
    assert.deepEqual(await f.cycle(), { removed: 0, held: 0, failed: 0 });
    assert.deepEqual((await fs.readdir(f.root)).sort(), ["hermes-memory-config.json"]);
  });

  it("pause and disable are reread on every cycle without stopping observation", async () => {
    const f = await fixture();
    for (const flags of [{ curatorPaused: true }, { curatorEnabled: false }, { curatorPaused: "false" }]) {
      await f.configure(flags);
      const before = await fs.readFile(f.curator.dbPath);
      assert.equal((await f.cycle()).removed, 0);
      assert.deepEqual(await fs.readFile(f.curator.dbPath), before);
      assert.ok(await fs.stat(f.globalPath));
    }
    await f.configure({ curatorPaused: false });
    assert.equal((await f.cycle()).removed, 2);
  });

  it("allows archive rollout with old-process pause retained and rejects malformed flags", async () => {
    const f = await fixture();
    await f.configure({ curatorPaused: true, curatorArchiveEnabled: "true" });
    assert.equal(readRunnerConfig(f.root), null);
    assert.equal((await f.cycle()).removed, 0);
    await f.configure({ curatorPaused: true, curatorArchiveEnabled: true });
    assert.equal(readRunnerConfig(f.root)?.paused, false);
    assert.equal((await f.cycle()).removed, 2);
    const archived = path.join(f.root, "pi-hermes-memory", "curator", "archive", "global", "unused-global");
    assert.equal((await fs.readdir(archived)).length, 1);
  });

  it("pins are applied across project and global roots", async () => {
    const f = await fixture();
    await f.configure({ curatorPolicy: { ...POLICY, pinnedSkillIds: ["global:unused-global", "project:project-one:unused-project"] } });
    assert.equal((await f.cycle()).removed, 0);
    assert.ok(await fs.stat(f.globalPath));
    assert.ok(await fs.stat(f.projectPath));
  });

  it("invalid, missing or partial configuration cannot grant authority", async () => {
    const f = await fixture();
    for (const content of ["{broken", "{}", JSON.stringify({ curatorPolicy: { inactivityDays: 10 } }),
      JSON.stringify({ curatorPolicy: POLICY, curatorEnabled: "true" })]) {
      await fs.writeFile(f.configPath, content);
      assert.equal((await f.cycle()).removed, 0);
    }
    await fs.unlink(f.configPath);
    assert.equal((await f.cycle()).removed, 0);
    assert.ok(await fs.stat(f.globalPath));
  });

  it("does not reinterpret authority when configured storage roots change", async () => {
    const f = await fixture();
    await f.configure({ memoryDir: "other-memory", projectsMemoryDir: "other-projects" });
    assert.equal((await f.cycle()).removed, 0);
    assert.ok(await fs.stat(f.globalPath));
    assert.ok(await fs.stat(f.projectPath));
  });

  it("rechecks pause after the plan and before acquiring removal authority", async () => {
    const f = await fixture();
    const original = CuratorStore.prototype.withMutation;
    let locks = 0;
    CuratorStore.prototype.withMutation = async function <T>(roots: string[], action: () => Promise<T>): Promise<T> {
      if (++locks === 2) await f.configure({ curatorPaused: true });
      return (original<T>).call(this, roots, action);
    };
    try { assert.equal((await f.cycle()).removed, 0); }
    finally { CuratorStore.prototype.withMutation = original; }
    assert.ok(locks >= 2);
    assert.ok(await fs.stat(f.globalPath));
  });

  it("overlapping runner processes cannot remove a generation twice", async () => {
    const f = await fixture();
    const results = await Promise.all([f.cli(["--once"]), f.cli(["--once"])]);
    for (const result of results) { assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); }
    assert.deepEqual(f.curator.list(), []);
    await assert.rejects(fs.stat(f.globalPath), { code: "ENOENT" });
  });

  it("protects a live cache and a live open observation in the independent process", async () => {
    const f = await fixture();
    f.curator.registerCacheOwner();
    f.curator.beginObservation(randomUUID(), "a".repeat(64));
    assert.equal((await f.cycle()).removed, 0);
    assert.equal(f.curator.observations().runs.some((run) => run.endedAt === null), true);
    assert.ok(await fs.stat(f.globalPath));
  });

  it("retires a confirmed exited unfinished run as faulted without inventing offline coverage", async () => {
    const f = await fixture();
    const stamp = new Date(Date.now() - 86400000).toISOString();
    await execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { CuratorStore } from './src/curator/store.ts';
      const curator = new CuratorStore({ agentRoot: ${JSON.stringify(f.root)}, now: () => new Date(${JSON.stringify(stamp)}) });
      curator.beginObservation(${JSON.stringify(randomUUID())}, 'b'.repeat(64));
      curator.registerCacheOwner();
      curator.close();
    `], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.root }, timeout: 15000 });
    assert.equal((await f.cycle()).removed, 0);
    const run = f.curator.observations().runs.find((entry) => entry.startedAt === stamp)!;
    assert.equal(run.state, "faulted");
    assert.equal(run.endedAt, stamp);
    assert.ok(f.curator.observations().gaps.some((gap) => gap.runId === run.runId));
    assert.ok(await fs.stat(f.globalPath));
  });

  it("runs the published CLI on Node without development-only tsx", async () => {
    const f = await fixture();
    const result = await f.cli(["--once"]);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    await assert.rejects(fs.stat(f.globalPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(f.projectPath), { code: "ENOENT" });
  });

  it("runs with production dependencies and no package-local SDK or tsx", async () => {
    const f = await fixture();
    const installed = path.join(f.root, "production-package");
    await fs.mkdir(installed);
    await fs.cp(path.join(cwd, "src"), path.join(installed, "src"), { recursive: true });
    await fs.mkdir(path.join(installed, "scripts"));
    await fs.copyFile(path.join(cwd, "scripts/curator.mjs"), path.join(installed, "scripts/curator.mjs"));
    await fs.copyFile(path.join(cwd, "package.json"), path.join(installed, "package.json"));
    const pkg = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
    for (const dependency of Object.keys(pkg.dependencies)) {
      const target = path.join(installed, "node_modules", dependency);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(cwd, "node_modules", dependency), target);
    }
    const requireInstalled = createRequire(path.join(installed, "package.json"));
    assert.throws(() => requireInstalled.resolve("@earendil-works/pi-coding-agent"), { code: "MODULE_NOT_FOUND" });
    assert.throws(() => requireInstalled.resolve("tsx"), { code: "MODULE_NOT_FOUND" });
    const result = await execute(process.execPath, ["scripts/curator.mjs", "--once"], {
      cwd: installed, env: { ...process.env, PI_CODING_AGENT_DIR: f.root }, timeout: 15000,
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    await assert.rejects(fs.stat(f.globalPath), { code: "ENOENT" });
  });

  it("stops the real watch process on SIGTERM without deletion notices", async () => {
    const f = await fixture();
    const child = spawn(process.execPath, ["scripts/curator.mjs", "--watch", "--interval-minutes", "1"], {
      cwd, env: { ...process.env, PI_CODING_AGENT_DIR: f.root }, timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    let terminated = false;
    const watcher = watch(path.dirname(f.globalPath), async () => {
      try { await fs.stat(f.globalPath); } catch {
        if (!terminated) { terminated = true; child.kill("SIGTERM"); }
      }
    });
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(terminated, true);
      assert.deepEqual(exit, { code: 0, signal: null });
      assert.equal(stdout, "");
      assert.equal(stderr, "");
    } finally { watcher.close(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); }
  });

  it("rejects invalid intervals before accessing any user state", async () => {
    const f = await fixture(false);
    for (const args of [["--watch"], ["--watch", "--interval-minutes", "0"],
      ["--watch", "--interval-minutes", "NaN"], ["--once", "--watch", "--interval-minutes", "1"]]) {
      await assert.rejects(f.cli(args));
    }
    assert.deepEqual(await fs.readdir(f.root), ["hermes-memory-config.json"]);
  });

  it("validates storage and pause settings consistently", async () => {
    const f = await fixture(false);
    await f.configure({ memoryDir: "memory", projectsMemoryDir: "../escape" });
    assert.equal(readRunnerConfig(f.root), null);
    await f.configure({ curatorPaused: "invalid" });
    assert.equal(loadConfig(f.configPath).curatorPaused, true);
    await f.configure({ curatorEnabled: "invalid" });
    assert.equal(loadConfig(f.configPath).curatorEnabled, false);
    await f.configure({ memoryDir: "memory" });
    assert.equal(readRunnerConfig(f.root)?.globalRoot, path.join(f.root, "pi-hermes-memory/skills"));
  });
});

describe("Curator serial periodic loop", () => {
  it("never overlaps cycles, catches faults and does not accumulate missed ticks", async () => {
    const controller = new AbortController();
    let cycles = 0;
    let running = false;
    await runPeriodicCurator({ intervalMs: 60000, signal: controller.signal,
      cycle: async () => {
        assert.equal(running, false);
        running = true;
        cycles++;
        await Promise.resolve();
        running = false;
        if (cycles === 1) throw new Error("temporary storage fault");
      },
      wait: async (interval, signal) => {
        assert.equal(interval, 60000);
        assert.equal(running, false);
        assert.equal(signal, controller.signal);
        if (cycles === 3) controller.abort();
      },
    });
    assert.equal(cycles, 3);
  });

  it("stops gracefully after the active cycle and cancels the real timer", async () => {
    const controller = new AbortController();
    let cycles = 0;
    await runPeriodicCurator({ intervalMs: 60000, signal: controller.signal,
      cycle: async () => { cycles++; setImmediate(() => controller.abort()); },
    });
    assert.equal(cycles, 1);
    await assert.rejects(runPeriodicCurator({ intervalMs: 0, signal: controller.signal, cycle: async () => {} }), /invalid-curator-interval/);
  });
});
