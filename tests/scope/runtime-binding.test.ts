import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProject, createScope } from "../../src/scope/catalog.js";
import { tempRoot } from "./fixtures.js";

test("real extension callbacks bind memory, skills and searches to one stable Scope", async (t) => {
  const root = await tempRoot("scope-runtime-");
  const workspace = join(root, "old-directory-name");
  const other = join(root, "unregistered");
  const catalogRoot = join(root, "catalog");
  await mkdir(workspace);
  await mkdir(other);
  const project = await createProject(catalogRoot, "Product");
  const registered = await createScope(catalogRoot, { root: workspace, projectId: project.projectId,
    name: "Backend", scopeId: "ws_runtime", memoryTag: "repo:old-tag" });
  const memoryDir = join(root, "projects-memory", registered.scopeId);
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, "MEMORY.md"), "Existing scoped memory");
  await writeFile(join(root, "hermes-memory-config.json"), JSON.stringify({
    projectResolutionMode: "catalog", scopeCatalogDir: catalogRoot, memoryMode: "legacy-inject",
    reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false, autoConsolidate: false,
    correctionDetection: false, standingInstructionsEnabled: false,
  }));
  const historyDir = join(root, "history");
  await mkdir(historyDir);
  await createScope(catalogRoot, { root: historyDir, projectId: project.projectId,
    name: "History", scopeId: "ws_history", memoryTag: "repo:history" });
  const oldEnvironment = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const handlers: Record<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]> = {};
  const tools: Record<string, { execute: (...args: any[]) => Promise<any> }> = {};
  const commands: Record<string, { handler: (...args: any[]) => Promise<any> }> = {};
  const pi = {
    on(event: string, callback: (event: unknown, ctx: unknown) => Promise<unknown>) { (handlers[event] ??= []).push(callback); },
    registerTool(tool: { name: string; execute: (...args: any[]) => Promise<any> }) { tools[tool.name] = tool; },
    registerCommand(name: string, command: { handler: (...args: any[]) => Promise<any> }) { commands[name] = command; },
  };
  const ctx = (cwd: string) => ({ cwd, hasUI: true, ui: { notify() {} },
    sessionManager: { getSessionId: () => "runtime", getSessionFile: () => undefined, getBranch: () => [], getHeader: () => null, getEntries: () => [] } });
  const current = ctx(workspace);
  try {
    const { DatabaseManager } = await import("../../src/store/db.js");
    const { indexSession } = await import("../../src/store/session-indexer.js");
    const { ProjectScopeBinding } = await import("../../src/scope/project-binding.js");
    const database = new DatabaseManager(join(root, "pi-hermes-memory"));
    database.setQuickCheckOnOpen(false);
    const historySession = (id: string, cwd: string, project: string) => ({ id, cwd, project,
      startedAt: "2026-10-01T00:00:00.000Z", endedAt: null,
      messages: [{ id: `${id}-message`, role: "user" as const, content: "Searchable history retained",
        timestamp: "2026-10-01T00:00:00.000Z" }] });
    try {
      indexSession(database, historySession("current-history", workspace, "old-directory-name"));
      indexSession(database, historySession("other-history", historyDir, "ws_history"));
    } finally { database.close(); }
    const resolvedPaths: string[] = [];
    const sessionProject = ProjectScopeBinding.prototype.sessionProject;
    t.mock.method(ProjectScopeBinding.prototype, "sessionProject", function(this: InstanceType<typeof ProjectScopeBinding>, cwd: string) {
      resolvedPaths.push(cwd);
      return sessionProject.call(this, cwd);
    });
    const { default: extension } = await import("../../src/index.js");
    extension(pi as any);
    for (const handler of handlers.session_start) await handler({}, current);
    assert.ok(resolvedPaths.includes(workspace), "current cwd history must still be bound");
    assert.ok(!resolvedPaths.includes(historyDir), "startup must not resolve unrelated historical paths");
    const readDb = new DatabaseManager(join(root, "pi-hermes-memory"));
    readDb.setQuickCheckOnOpen(false);
    try {
      const rows = readDb.getDb().prepare("SELECT id, project FROM sessions ORDER BY id").all();
      assert.deepEqual(rows, [
        { id: "current-history", project: "ws_runtime" },
        { id: "other-history", project: "ws_history" },
      ]);
    } finally { readDb.close(); }
    const history = await tools.session_search.execute("history-search", { query: "Searchable history retained",
      project: "Product/History" }, undefined, undefined, current);
    assert.match(JSON.stringify(history), /Searchable history retained/);
    const resources = await handlers.resources_discover[0]({ cwd: workspace }, current) as { skillPaths: string[] };
    assert.ok(resources.skillPaths.includes(join(memoryDir, "skills")));
    assert.ok(!resources.skillPaths.some((value) => value.includes("projects-memory/old-directory-name")));
    const prompt = await handlers.before_agent_start[0]({ systemPrompt: "base" }, current) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Existing scoped memory/);
    assert.match(prompt.systemPrompt, /Product\/Backend/);
    const memory = await tools.memory_add.execute("scope-memory", { target: "project", content: "Stable Scope write" }, undefined, undefined, current);
    assert.equal(memory.details.success, true);
    assert.match(await readFile(join(memoryDir, "MEMORY.md"), "utf8"), /Stable Scope write/);
    const candidate = await tools.skill_manage.execute("scope-candidate", { action: "consider", name: "scope-workflow",
      scope: "project", criteria: [true, true, true, true] }, undefined, undefined, current);
    assert.equal(candidate.details.approved, true);
    const skill = await tools.skill_manage.execute("scope-skill", { action: "create", name: "scope-workflow", description: "Reusable Scope workflow",
      scope: "project", content: "## Procedure\n1. Verify Scope identity", approval_token: candidate.details.approvalToken }, undefined, undefined, current);
    assert.equal(skill.details.skillId, "project:ws_runtime:scope-workflow");
    const skillFile = join(memoryDir, "skills/scope-workflow/SKILL.md");
    assert.doesNotMatch(await readFile(skillFile, "utf8"), /pi-hermes-generation/);
    assert.equal(commands["memory-curator"], undefined);
    await assert.rejects(stat(join(root, "pi-hermes-memory", "curator")), { code: "ENOENT" });
    await assert.rejects(stat(join(root, "projects-memory", "old-directory-name")), { code: "ENOENT" });
    const search = await tools.memory_search.execute("scope-search", { query: "Stable Scope write", project: "Product/Backend" }, undefined, undefined, current);
    assert.match(JSON.stringify(search), /Stable Scope write/);
    const absent = ctx(other);
    const refused = await tools.memory_add.execute("unregistered", { target: "project", content: "Do not fall back" }, undefined, undefined, absent);
    assert.equal(refused.details.success, false);
    const refusedSkill = await tools.skill_manage.execute("unregistered-skill", { action: "create", name: "should-not-exist", description: "Forbidden fallback",
      scope: "project", content: "body", explicit_user_request: true }, undefined, undefined, absent);
    assert.equal(refusedSkill.details.success, false);
    await assert.rejects(stat(join(root, "projects-memory", "unregistered")), { code: "ENOENT" });
  } finally {
    for (const handler of handlers.session_shutdown ?? []) await handler({}, current);
    if (oldEnvironment === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnvironment;
  }
});
