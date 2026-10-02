import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProject, createScope } from "../../src/scope/catalog.js";
import { CuratorStore } from "../../src/curator/store.js";
import { tempRoot } from "./fixtures.js";

test("real extension callbacks bind memory, skills, searches and Curator to one stable Scope", async () => {
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
  const messages: string[] = [];
  const ctx = (cwd: string) => ({ cwd, hasUI: true, ui: { notify: (message: string) => messages.push(message) },
    sessionManager: { getSessionId: () => "runtime", getSessionFile: () => undefined, getBranch: () => [], getHeader: () => null, getEntries: () => [] } });
  const current = ctx(workspace);
  try {
    const { default: extension } = await import("../../src/index.js");
    extension(pi as any);
    for (const handler of handlers.session_start) await handler({}, current);
    const resources = await handlers.resources_discover[0]({ cwd: workspace }, current) as { skillPaths: string[] };
    assert.ok(resources.skillPaths.includes(join(memoryDir, "skills")));
    assert.ok(!resources.skillPaths.some((value) => value.includes("projects-memory/old-directory-name")));
    const prompt = await handlers.before_agent_start[0]({ systemPrompt: "base" }, current) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Existing scoped memory/);
    assert.match(prompt.systemPrompt, /Product\/Backend/);
    const memory = await tools.memory_add.execute("scope-memory", { target: "project", content: "Stable Scope write" }, undefined, undefined, current);
    assert.equal(memory.details.success, true);
    assert.match(await readFile(join(memoryDir, "MEMORY.md"), "utf8"), /Stable Scope write/);
    const skill = await tools.skill_manage.execute("scope-skill", { action: "create", name: "scope-workflow", description: "Reusable Scope workflow",
      scope: "project", content: "## Procedure\n1. Verify Scope identity" }, undefined, undefined, current);
    assert.equal(skill.details.skillId, "project:ws_runtime:scope-workflow");
    await stat(join(memoryDir, "skills/scope-workflow/SKILL.md"));
    const curator = new CuratorStore({ agentRoot: root });
    try { assert.equal(curator.list()[0]?.skillId, "project:ws_runtime:scope-workflow"); } finally { curator.close(); }
    await commands["memory-curator"].handler("inventory", current);
    assert.match(messages.at(-1)!, /project:ws_runtime:scope-workflow/);
    await assert.rejects(stat(join(root, "projects-memory", "old-directory-name")), { code: "ENOENT" });
    const search = await tools.memory_search.execute("scope-search", { query: "Stable Scope write", project: "Product/Backend" }, undefined, undefined, current);
    assert.match(JSON.stringify(search), /Stable Scope write/);
    const absent = ctx(other);
    const refused = await tools.memory_add.execute("unregistered", { target: "project", content: "Do not fall back" }, undefined, undefined, absent);
    assert.equal(refused.details.success, false);
    const refusedSkill = await tools.skill_manage.execute("unregistered-skill", { action: "create", name: "should-not-exist", description: "Forbidden fallback",
      scope: "project", content: "body" }, undefined, undefined, absent);
    assert.equal(refusedSkill.details.success, false);
    await assert.rejects(stat(join(root, "projects-memory", "unregistered")), { code: "ENOENT" });
  } finally {
    for (const handler of handlers.session_shutdown ?? []) await handler({}, current);
    if (oldEnvironment === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnvironment;
  }
});
