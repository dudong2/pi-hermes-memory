import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { createProject, createScope } from "../../src/scope/catalog.js";
import { ProjectScopeBinding, safeScopeKey } from "../../src/scope/project-binding.js";
import { pathWorkspaceId } from "../../src/scope/marker.js";
import { buildSkillId, parseSkillId } from "../../src/store/skill-utils.js";
import { SkillStore } from "../../src/store/skill-store.js";
import { syncScopeStoreMetadata } from "../../src/hindsight/store-metadata.js";
import { DatabaseManager } from "../../src/store/db.js";
import { indexSession } from "../../src/store/session-indexer.js";
import { rebindIndexedSessions } from "../../src/scope/session-binding.js";
import { syncMarkdownMemoriesToSqlite } from "../../src/handlers/sync-markdown-memories.js";
import { loadConfig } from "../../src/config.js";
import { tempRoot } from "./fixtures.js";

async function fixture() {
  const root = await tempRoot("scope-bind-");
  const workspace = join(root, "workspace");
  const dataDir = join(root, "catalog");
  const projectsRoot = join(root, "projects-memory");
  await mkdir(workspace);
  const project = await createProject(dataDir, "Product");
  const scope = await createScope(dataDir, { root: workspace, projectId: project.projectId,
    name: "Backend", scopeId: "ws_stable", memoryTag: "repo:old-tag", legacyHermesNames: ["OldBackend"] });
  const config = { projectResolutionMode: "catalog" as const, scopeCatalogDir: dataDir };
  return { root, workspace, dataDir, projectsRoot, scope, config,
    binding: new ProjectScopeBinding(config, projectsRoot) };
}

test("uses scopeId for storage and qualified names only for display without catalog writes", async () => {
  const f = await fixture();
  const catalog = join(f.dataDir, "scope-catalog.json");
  const before = await readFile(catalog);
  const markerBefore = await readFile(f.scope.markerPath);
  const info = f.binding.resolve(f.workspace);
  assert.equal(info.name, f.scope.scopeId);
  assert.equal(info.displayName, "Product/Backend");
  assert.equal(info.memoryDir, join(f.projectsRoot, f.scope.scopeId));
  assert.deepEqual(await readFile(catalog), before);
  assert.deepEqual(await readFile(f.scope.markerPath), markerBefore);
  await assert.rejects(stat(f.projectsRoot), { code: "ENOENT" });
});

test("preserves canonical path-derived Scope IDs without disabling neighboring Scopes", async () => {
  const f = await fixture();
  const workspace = join(f.root, "path-workspace");
  await mkdir(workspace);
  const scopeId = pathWorkspaceId(workspace, f.root);
  const scope = await createScope(f.dataDir, { root: workspace, projectId: f.scope.projectId,
    name: "Path Scope", scopeId, memoryTag: "scope:existing-path" });
  const before = await readFile(join(f.dataDir, "scope-catalog.json"));
  f.binding.refresh();
  assert.equal(f.binding.available, true);
  assert.equal(f.binding.resolve(f.workspace).name, f.scope.scopeId);
  assert.equal(f.binding.resolve(workspace).name, scopeId);
  assert.equal(f.binding.resolve(workspace).memoryDir, join(f.projectsRoot, scopeId));
  assert.equal(f.binding.selector(scopeId), scopeId);
  await syncScopeStoreMetadata({ ...scope, projectName: "Product", scopeName: "Path Scope", root: workspace,
    cwd: workspace, memoryTags: [scope.memoryTag] } as any, f.projectsRoot);
  assert.deepEqual(await readFile(join(f.dataDir, "scope-catalog.json")), before);
  assert.deepEqual(parseSkillId(buildSkillId("project", "path-workflow", scopeId)),
    { scope: "project", projectName: scopeId, slug: "path-workflow" });
  const store = new SkillStore({ globalSkillsDir: join(f.root, "global-skills"),
    piGlobalSkillsDir: join(f.root, "pi-skills"), legacySkillsDir: join(f.root, "legacy-skills"),
    migrationSentinelPath: join(f.root, "skill-sentinel"),
    projectSkillsDir: join(f.projectsRoot, scopeId, "skills"), projectName: scopeId });
  const created = await store.create("path-workflow", "Reusable path Scope workflow", "## Procedure\nUse the stable Scope key.", "project");
  assert.equal(created.success, true);
  assert.equal((await store.loadSkill(created.skillId!))?.skillId, created.skillId);
});

test("canonical path Scope keys do not authorize arbitrary colons or traversal", () => {
  const valid = pathWorkspaceId("/fixture/workspace", "/fixture");
  assert.equal(safeScopeKey(valid), true);
  for (const invalid of ["path:../escape", "path:short", `${valid}/child`, "other:value", "../escape", "C:folder"])
    assert.equal(safeScopeKey(invalid), false);
});

test("unregistered and malformed markers never fall back to directory names", async () => {
  const f = await fixture();
  const unknown = join(f.root, "unknown");
  await mkdir(unknown);
  assert.equal(f.binding.resolve(unknown).name, null);
  await writeFile(f.scope.markerPath, "{broken");
  assert.equal(f.binding.resolve(f.workspace).name, null);
  assert.equal(f.binding.resolve(f.workspace).memoryDir, null);
});

test("moving a marker-bearing Scope does not rename storage or overwrite its registry", async () => {
  const f = await fixture();
  const moved = join(f.root, "new-directory-name");
  const before = await readFile(join(f.dataDir, "scope-catalog.json"));
  await rename(f.workspace, moved);
  assert.equal(f.binding.resolve(moved).memoryDir, join(f.projectsRoot, f.scope.scopeId));
  assert.deepEqual(await readFile(join(f.dataDir, "scope-catalog.json")), before);
});

test("Scope selectors resolve IDs and unambiguous names but reject Project-wide guesses", async () => {
  const f = await fixture();
  assert.equal(f.binding.selector("ws_stable"), "ws_stable");
  assert.equal(f.binding.selector("Product/Backend"), "ws_stable");
  assert.equal(f.binding.selector("backend"), "ws_stable");
  assert.throws(() => f.binding.selector("Product"), /missing or ambiguous/);
});

test("catalog failure clears prior binding instead of retaining a previous Scope", async () => {
  const f = await fixture();
  await writeFile(join(f.dataDir, "scope-catalog.json"), "{broken");
  f.binding.refresh();
  assert.equal(f.binding.available, false);
  assert.equal(f.binding.resolve(f.workspace).name, null);
  assert.equal(f.binding.keys().size, 0);
});

test("Git identity mismatch does not bind the old Scope or repair its marker", async () => {
  const f = await fixture();
  execFileSync("git", ["-C", f.workspace, "init", "-q"]);
  execFileSync("git", ["-C", f.workspace, "remote", "add", "origin", "https://example.com/new.git"]);
  assert.equal(f.binding.resolve(f.workspace).name, null);
});

test("indexes new and existing sessions under stable Scope IDs without rewriting source messages", async () => {
  const f = await fixture();
  const db = new DatabaseManager(join(f.root, "database"));
  try {
    const session = { id: "session-stable", project: basename(f.workspace), cwd: f.workspace,
      startedAt: "2026-01-01T00:00:00.000Z", endedAt: null,
      messages: [{ id: "msg-stable", role: "user" as const, content: "Preserve history", timestamp: "2026-01-01T00:00:00.000Z" }] };
    indexSession(db, session);
    indexSession(db, { ...session, id: "unmapped-history", cwd: join(f.root, "missing-unknown"), project: "Preserve prior label", messages: [] });
    db.setSessionProjectResolver((cwd) => f.binding.sessionProject(cwd));
    rebindIndexedSessions(db);
    assert.equal((db.getDb().prepare("SELECT project FROM sessions WHERE id = ?").get("unmapped-history") as { project: string }).project, "Preserve prior label");
    assert.equal((db.getDb().prepare("SELECT project FROM sessions WHERE id = ?").get(session.id) as { project: string }).project, "ws_stable");
    indexSession(db, { ...session, id: "session-new", messages: [] });
    assert.equal((db.getDb().prepare("SELECT project FROM sessions WHERE id = ?").get("session-new") as { project: string }).project, "ws_stable");
    assert.equal((db.getDb().prepare("SELECT content FROM messages WHERE id = ?").get("msg-stable") as { content: string }).content, "Preserve history");
  } finally { db.close(); }
});

test("scoped markdown mirror leaves legacy name-based memories and files untouched", async () => {
  const f = await fixture();
  const global = join(f.root, "pi-hermes-memory");
  const old = join(f.projectsRoot, "OldBackend");
  const scoped = join(f.projectsRoot, "ws_stable");
  await mkdir(old, { recursive: true });
  await mkdir(scoped, { recursive: true });
  await writeFile(join(old, "MEMORY.md"), "Legacy preserved");
  await writeFile(join(scoped, "MEMORY.md"), "Scope current");
  const db = new DatabaseManager(global);
  try {
    db.setProjectMemoryKeys(new Set(["ws_stable"]));
    await syncMarkdownMemoriesToSqlite(db, global, "projects-memory", f.root);
    const projects = db.getDb().prepare("SELECT DISTINCT project FROM memories WHERE project IS NOT NULL").all() as { project: string }[];
    assert.deepEqual(projects, [{ project: "ws_stable" }]);
    assert.equal(await readFile(join(old, "MEMORY.md"), "utf8"), "Legacy preserved");
    await rename(join(scoped, "MEMORY.md"), join(scoped, "MEMORY.backup"));
    await syncMarkdownMemoriesToSqlite(db, global, "projects-memory", f.root);
    assert.equal((db.getDb().prepare("SELECT COUNT(*) AS count FROM memories WHERE project = ?").get("ws_stable") as { count: number }).count, 1);
  } finally { db.close(); }
});

test("invalid or previous external-resolution settings cannot silently authorize cwd fallback", async () => {
  const root = await tempRoot("scope-config-");
  const file = join(root, "config.json");
  await writeFile(file, JSON.stringify({ projectResolutionMode: "external" }));
  const config = loadConfig(file);
  assert.equal(config.projectResolutionMode, "disabled");
  assert.equal(new ProjectScopeBinding(config).resolve(root).memoryDir, null);
});
