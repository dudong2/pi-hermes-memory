import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createProject, createScope, loadScopeCatalog } from "../../src/scope/catalog.js";
import { resolveScope } from "../../src/scope/resolver.js";
import { tempRoot } from "./fixtures.js";

const lockName = "scope-catalog.json.lock";

test("does not replace a live catalog owner solely because its lock is old", { timeout: 10000 }, async () => {
  const root = await tempRoot("scope-live-lock-");
  const lock = join(root, lockName);
  const content = `${process.pid}\n${new Date().toISOString()}\n`;
  await writeFile(lock, content);
  const old = new Date(Date.now() - 60000);
  await utimes(lock, old, old);
  await assert.rejects(createProject(root, "Must wait"), /timed out waiting for lock/);
  assert.equal(await readFile(lock, "utf8"), content);
  await assert.rejects(stat(join(root, "scope-catalog.json")), { code: "ENOENT" });
});

test("recovers a catalog lock only after its owning process demonstrably exits", { timeout: 10000 }, async () => {
  const root = await tempRoot("scope-exited-lock-");
  const pid = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  await writeFile(join(root, lockName), `${pid}\n${new Date().toISOString()}\n`);
  const project = await createProject(root, "Recovered");
  assert.equal((await loadScopeCatalog(root)).projects[project.projectId].name, "Recovered");
});

test("never overwrites an existing Project ID with another Project", async () => {
  const root = await tempRoot("scope-project-id-");
  const first = await createProject(root, "First", [], "project_existing");
  const before = await readFile(join(root, "scope-catalog.json"));
  await assert.rejects(createProject(root, "Second", [], first.projectId), /already registered/);
  assert.deepEqual(await readFile(join(root, "scope-catalog.json")), before);
});

test("never overwrites an existing Scope ID or its memory tag", async () => {
  const root = await tempRoot("scope-id-preserve-");
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const project = await createProject(root, "Product");
  const first = await createScope(root, { root: firstRoot, projectId: project.projectId, name: "First",
    scopeId: "ws_existing", memoryTag: "repo:legacy-existing" });
  const before = await readFile(join(root, "scope-catalog.json"));
  await assert.rejects(createScope(root, { root: secondRoot, projectId: project.projectId,
    name: "Second", scopeId: first.scopeId }), /already registered/);
  assert.deepEqual(await readFile(join(root, "scope-catalog.json")), before);
  await assert.rejects(stat(join(secondRoot, ".pi-memory-scope.json")), { code: "ENOENT" });
});

test("preserves existing opaque IDs and memory while resolving without migration", async () => {
  const root = await tempRoot("scope-existing-data-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const project = await createProject(root, "Existing project");
  const scope = await createScope(root, { root: workspace, projectId: project.projectId, name: "Existing scope",
    scopeId: "ws_existing", memoryTag: "repo:legacy-tag", legacyHermesNames: ["LuckyCat"] });
  const memoryDir = join(root, "projects-memory", scope.scopeId);
  const oldDir = join(root, "projects-memory", "LuckyCat");
  for (const directory of [memoryDir, oldDir]) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "MEMORY.md"), `Persistent contents in ${directory}`);
  }
  const snapshots = await Promise.all([memoryDir, oldDir].map(async (directory) => ({
    file: join(directory, "MEMORY.md"), bytes: await readFile(join(directory, "MEMORY.md")),
    mtime: (await stat(join(directory, "MEMORY.md"))).mtimeMs,
  })));
  const resolved = await resolveScope(workspace, { dataDir: root });
  assert.equal(resolved?.scopeId, scope.scopeId);
  assert.equal(resolved?.scopeTag, scope.memoryTag);
  assert.deepEqual(resolved?.legacyHermesNames, ["LuckyCat"]);
  for (const snapshot of snapshots) {
    assert.deepEqual(await readFile(snapshot.file), snapshot.bytes);
    assert.equal((await stat(snapshot.file)).mtimeMs, snapshot.mtime);
  }
});

test("requires an explicit absolute data directory rather than using live default state", async () => {
  const root = await tempRoot("scope-explicit-state-");
  await assert.rejects(resolveScope(root, { dataDir: "relative-state" }), /must-be-absolute/);
  await assert.rejects(createProject("relative-state", "Unbound"), /must-be-absolute/);
});

test("serializes real catalog writers without losing another registration", async () => {
  const root = await tempRoot("scope-concurrent-writers-");
  const execute = promisify(execFile);
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  await Promise.all(["First", "Second", "Third", "Fourth"].map((name) => execute(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `
      import { createProject } from "./src/scope/catalog.ts";
      await createProject(${JSON.stringify(root)}, ${JSON.stringify(name)});
    `], { cwd, timeout: 15000, env: { ...process.env, PI_CODING_AGENT_DIR: root } })));
  assert.deepEqual(Object.values((await loadScopeCatalog(root)).projects).map((project) => project.name).sort(),
    ["First", "Fourth", "Second", "Third"]);
});
