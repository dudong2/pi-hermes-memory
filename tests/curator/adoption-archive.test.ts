import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { SkillStore } from "../../src/store/skill-store.js";
import { CuratorStore } from "../../src/curator/store.js";
import { createAdoptionCohort, loadAdoptedUsage, runAdoptedArchiveCycle } from "../../src/curator/adoption-archive.ts";
import { runAdoptedStartupCycle } from "../../src/curator/adoption-runner.ts";
import { prepareArchiveDestination } from "../../src/curator/archive-files.ts";
import { inventorySkills } from "../../src/curator/inventory.js";

const DAY = 86_400_000;
const now = new Date("2026-10-05T16:30:00.000Z");
const later = (days: number) => new Date(now.getTime() + days * DAY);
const policy = { inactivityDays: 14, minimumObservationDays: 14, creationGraceDays: 14,
  modificationGraceDays: 14, adoptionGraceDays: 14, maxObservationAgeDays: 2 };

test("user-designated existing skills wait fourteen days, reset on use, and archive whole directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "curator-adoption-"));
  const curator = new CuratorStore({ agentRoot: root });
  try {
    const skillRoot = path.join(root, "pi-hermes-memory", "skills");
    const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external") });
    assert.equal((await skills.create("old-one", "Reusable", "## Procedure\n1. Inspect", "global")).success, true);
    assert.equal((await skills.create("old-two", "Reusable", "## Procedure\n1. Inspect", "global")).success, true);
    assert.equal((await skills.create("protected", "Reusable", "## Procedure\n1. Inspect", "global")).success, true);
    const asset = path.join(skillRoot, "old-one", "reference.txt");
    await fs.writeFile(asset, "keep asset");
    const roots = [{ scope: "global" as const, path: skillRoot }];
    const ids = ["global:old-one", "global:old-two"];
    await createAdoptionCohort({ agentRoot: root, roots, skillIds: ids, now });
    const usage = new Map<string, string>();
    const cycle = (at: Date, paused = false) => runAdoptedArchiveCycle({ agentRoot: root, roots, policy,
      paused, now: at, curator, usage: async () => ({ complete: true, lastSeenAt: usage }) });
    assert.equal((await cycle(later(13))).archived, 0);
    assert.equal((await cycle(later(14), true)).eligible, 2);
    assert.ok(await fs.stat(path.join(skillRoot, "old-one", "SKILL.md")));
    usage.set("global:old-two", later(10).toISOString());
    const result = await cycle(later(14));
    assert.equal(result.archived, 1);
    assert.ok(await fs.stat(path.join(skillRoot, "protected", "SKILL.md")));
    assert.ok(await fs.stat(path.join(skillRoot, "old-two", "SKILL.md")));
    await assert.rejects(fs.stat(path.join(skillRoot, "old-one")), { code: "ENOENT" });
    const archive = path.join(root, "pi-hermes-memory", "curator", "archive", "global", "old-one");
    const entries = await fs.readdir(archive);
    assert.equal(entries.length, 1);
    assert.equal(await fs.readFile(path.join(archive, entries[0], "reference.txt"), "utf8"), "keep asset");
    assert.ok(await fs.stat(path.join(archive, entries[0], "SKILL.md")));
    assert.equal((await cycle(later(24))).archived, 1);
    await assert.rejects(fs.stat(path.join(skillRoot, "old-two")), { code: "ENOENT" });
  } finally { curator.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("startup preview obeys pause and rereads pins before archiving", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "curator-adoption-runner-"));
  try {
    const skillRoot = path.join(root, "pi-hermes-memory", "skills");
    const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external") });
    await skills.create("old", "Reusable", "## Procedure\n1. Inspect", "global");
    await createAdoptionCohort({ agentRoot: root, roots: [{ scope: "global", path: skillRoot }],
      skillIds: ["global:old"], now });
    const configPath = path.join(root, "hermes-memory-config.json");
    const configure = (paused: boolean, pins: string[] = []) => fs.writeFile(configPath,
      JSON.stringify({ curatorPaused: paused, curatorPolicy: { ...policy, pinnedSkillIds: pins } }));
    const usage = async () => ({ complete: true, lastSeenAt: new Map<string, string>() });
    await configure(true);
    assert.equal((await runAdoptedStartupCycle({ agentRoot: root, now: later(14), usage })).eligible, 1);
    assert.ok(await fs.stat(path.join(skillRoot, "old", "SKILL.md")));
    await configure(false, ["global:old"]);
    assert.equal((await runAdoptedStartupCycle({ agentRoot: root, now: later(14), usage })).archived, 0);
    await configure(false);
    const preview = await runAdoptedStartupCycle({ agentRoot: root, now: later(14), usage, dryRunOnly: true });
    assert.equal(preview.eligible, 1);
    assert.equal(preview.archived, 0);
    assert.ok(await fs.stat(path.join(skillRoot, "old", "SKILL.md")));
    assert.equal((await runAdoptedStartupCycle({ agentRoot: root, now: later(14), usage })).archived, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("creation grace is measured from adoption, while inactivity resets on later use", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "curator-adoption-grace-"));
  const curator = new CuratorStore({ agentRoot: root });
  try {
    const skillRoot = path.join(root, "pi-hermes-memory", "skills");
    const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external") });
    await skills.create("old", "Reusable", "## Procedure\n1. Inspect", "global");
    const roots = [{ scope: "global" as const, path: skillRoot }];
    await createAdoptionCohort({ agentRoot: root, roots, skillIds: ["global:old"], now });
    const usage = async () => ({ complete: true, lastSeenAt: new Map([["global:old", later(20).toISOString()]]) });
    const periods = { ...policy, creationGraceDays: 30 };
    assert.equal((await runAdoptedArchiveCycle({ agentRoot: root, roots, policy: periods,
      paused: false, now: later(33), curator, usage })).archived, 0);
    assert.equal((await runAdoptedArchiveCycle({ agentRoot: root, roots, policy: periods,
      paused: false, now: later(34), curator, usage })).archived, 1);
  } finally { curator.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("saved Pi use after adoption resets the clock, and incomplete cohort evidence holds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "curator-adoption-use-"));
  const curator = new CuratorStore({ agentRoot: root });
  try {
    const skillRoot = path.join(root, "pi-hermes-memory", "skills");
    const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external") });
    await skills.create("old", "Reusable", "## Procedure\n1. Inspect", "global");
    const file = path.join(skillRoot, "old", "SKILL.md");
    const cohort = path.join(root, "pi-hermes-memory", "curator", "usage-cohort.json");
    await fs.mkdir(path.dirname(cohort), { recursive: true });
    await fs.writeFile(cohort, JSON.stringify({ start: later(-1).toISOString(),
      skills: [{ id: "global:old", path: file }] }));
    const roots = [{ scope: "global" as const, path: skillRoot }];
    const manifest = await createAdoptionCohort({ agentRoot: root, roots, skillIds: ["global:old"], now });
    const sessionDir = path.join(root, "sessions", "project");
    await fs.mkdir(sessionDir, { recursive: true });
    const at = later(10).toISOString();
    const lines = [
      { type: "session", version: 3, id: "s1", cwd: root },
      { type: "message", id: "call", timestamp: at, message: { role: "assistant", content: [
        { type: "toolCall", id: "t1", name: "read", arguments: { path: file } }] } },
      { type: "message", id: "result", timestamp: at, message: { role: "toolResult", toolCallId: "t1",
        toolName: "read", isError: false, content: [] } },
    ];
    await fs.writeFile(path.join(sessionDir, "s1.jsonl"), lines.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const usage = await loadAdoptedUsage(root, manifest);
    assert.equal(usage.complete, true);
    assert.equal(usage.lastSeenAt.get("global:old"), at);
    assert.equal((await runAdoptedArchiveCycle({ agentRoot: root, roots, policy, paused: false,
      now: later(14), curator, usage: () => loadAdoptedUsage(root, manifest) })).archived, 0);
    assert.ok(await fs.stat(file));
    const sessionFile = path.join(sessionDir, "s1.jsonl");
    await fs.appendFile(sessionFile, "{incomplete json\n");
    assert.equal((await loadAdoptedUsage(root, manifest)).complete, false);
    await fs.writeFile(sessionFile, lines.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await fs.appendFile(sessionFile, JSON.stringify({ type: "message", id: "nested", timestamp: at,
      message: { role: "toolResult", toolName: "codemode", nestedCalls: { complete: false, calls: [] } } }) + "\n");
    assert.equal((await loadAdoptedUsage(root, manifest)).complete, false);
    await fs.writeFile(sessionFile, lines.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await fs.writeFile(cohort, JSON.stringify({ start: later(1).toISOString(), skills: [] }));
    assert.equal((await loadAdoptedUsage(root, manifest)).complete, false);
  } finally { curator.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("explicit enrollment excludes the relocated protected skill without editing source files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "curator-adoption-cli-"));
  try {
    const skillRoot = path.join(root, "pi-hermes-memory", "skills");
    const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external") });
    await skills.create("old", "Reusable", "## Procedure\n1. Inspect", "global");
    const original = path.join(skillRoot, "old", "SKILL.md");
    const bytes = await fs.readFile(original);
    const protectedId = "project:other-scope:protected";
    const cohort = path.join(root, "pi-hermes-memory", "curator", "usage-cohort.json");
    await fs.mkdir(path.dirname(cohort), { recursive: true });
    await fs.writeFile(cohort, JSON.stringify({ start: now.toISOString(), skills: [
      { id: "global:old", path: original },
      { id: protectedId, path: path.join(root, "repo", ".agents", "skills", "protected", "SKILL.md") },
    ] }));
    await fs.writeFile(path.join(root, "hermes-memory-config.json"),
      JSON.stringify({ curatorPolicy: policy, curatorPaused: true }));
    const execute = (...args: string[]) => spawnSync(process.execPath, ["scripts/curator-adopt.mjs", ...args], {
      cwd: path.resolve("."), env: { ...process.env, PI_CODING_AGENT_DIR: root }, encoding: "utf8",
    });
    assert.notEqual(execute("--init", "--exclude", protectedId, "--expect", "2").status, 0);
    const installed = execute("--init", "--exclude", protectedId, "--expect", "1");
    assert.equal(installed.status, 0, installed.stderr);
    const manifest = path.join(root, "pi-hermes-memory", "curator", "adopted-archive.json");
    const before = await fs.readFile(manifest);
    assert.equal(JSON.parse(before.toString()).skills.length, 1);
    assert.equal((await fs.stat(manifest)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readFile(original), bytes);
    assert.notEqual(execute("--init", "--exclude", protectedId, "--expect", "1").status, 0);
    assert.deepEqual(await fs.readFile(manifest), before);
    assert.equal(JSON.parse(execute("--list").stdout).active, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("archive paths cannot escape the private archive root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "curator-archive-path-"));
  try {
    const directory = path.join(root, "skill");
    await fs.mkdir(directory);
    for (const skillId of ["global:../../outside", "project:../outside:skill"]) {
      await assert.rejects(prepareArchiveDestination({ agentRoot: root, skillId, directory }),
        /invalid-archive-skill-id/);
    }
    await assert.rejects(fs.stat(path.join(root, "pi-hermes-memory", "curator", "archive")), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("changed files and an incomplete usage audit cannot be archived", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "curator-adoption-safety-"));
  const curator = new CuratorStore({ agentRoot: root });
  try {
    const skillRoot = path.join(root, "pi-hermes-memory", "skills");
    const skills = new SkillStore({ globalSkillsDir: skillRoot, piGlobalSkillsDir: path.join(root, "external") });
    await skills.create("old", "Reusable", "## Procedure\n1. Inspect", "global");
    const roots = [{ scope: "global" as const, path: skillRoot }];
    await createAdoptionCohort({ agentRoot: root, roots, skillIds: ["global:old"], now });
    const file = path.join(skillRoot, "old", "SKILL.md");
    const listed = await inventorySkills({ roots, curator });
    assert.equal(listed.skills[0].source, "user-designated-hermes");
    assert.equal(listed.skills[0].generation, "adopted-snapshot");
    assert.equal((await runAdoptedArchiveCycle({ agentRoot: root, roots, policy, paused: false,
      now: later(20), curator, usage: async () => ({ complete: false, lastSeenAt: new Map() }) })).archived, 0);
    await fs.appendFile(file, "\nNew user edit\n");
    assert.equal((await inventorySkills({ roots, curator })).skills[0].source, "unknown");
    const result = await runAdoptedArchiveCycle({ agentRoot: root, roots, policy, paused: false,
      now: later(20), curator, usage: async () => ({ complete: true, lastSeenAt: new Map() }) });
    assert.equal(result.archived, 0);
    assert.match(await fs.readFile(file, "utf8"), /New user edit/);
  } finally { curator.close(); await fs.rm(root, { recursive: true, force: true }); }
});
