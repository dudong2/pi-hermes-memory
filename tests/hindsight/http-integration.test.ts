import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProject, createScope } from "../../src/scope/catalog.js";
import { registerHindsightIntegration } from "../../src/hindsight/integration.js";
import { syncScopeStoreMetadata } from "../../src/hindsight/store-metadata.js";
import { tempRoot } from "../scope/fixtures.js";

function mockPi() {
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  const tools: Record<string, { execute: (...args: any[]) => Promise<any> }> = {};
  const commands: Record<string, { handler: (...args: any[]) => Promise<any> }> = {};
  return { handlers, tools, commands, pi: {
    on: (name: string, callback: (event: any, ctx: any) => Promise<any>) => { handlers[name] = callback; },
    registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => { tools[tool.name] = tool; },
    registerCommand: (name: string, command: { handler: (...args: any[]) => Promise<any> }) => { commands[name] = command; },
  } };
}

test("disabled integration reads no existing settings and creates no outbox", async () => {
  const root = await tempRoot("hindsight-disabled-");
  const mock = mockPi();
  registerHindsightIntegration(mock.pi as any, { hindsightEnabled: false, hindsightSettingsPath: join(root, "missing.json") }, async () => { throw new Error("must not run"); });
  assert.deepEqual(mock.tools, {});
  assert.deepEqual(mock.handlers, {});
  assert.deepEqual(await readdir(root), []);
});

test("a different Scope catalog disables the new owner rather than splitting storage", async () => {
  const root = await tempRoot("hindsight-catalog-mismatch-");
  const settings = join(root, "config.json");
  await writeFile(settings, JSON.stringify({ dataDir: join(root, "other-state") }));
  const mock = mockPi();
  registerHindsightIntegration(mock.pi as any, { hindsightEnabled: true, projectResolutionMode: "catalog",
    scopeCatalogDir: root, hindsightSettingsPath: settings }, async () => {});
  assert.deepEqual(mock.tools, {});
  assert.ok(mock.commands["memory-hindsight-status"]);
  assert.deepEqual(await readdir(root), ["config.json"]);
});

test("loopback HTTP lifecycle preserves current-Scope retain, exact confirmation and reversible correction", async () => {
  const root = await tempRoot("hindsight-http-");
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const project = await createProject(state, "Product");
  const scope = await createScope(state, { root: workspace, projectId: project.projectId,
    name: "Backend", scopeId: "scope_http", memoryTag: "repo:existing" });
  const requests: { method: string; path: string; body: any }[] = [];
  const completed = new Set<string>();
  let node = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const value = body ? JSON.parse(body) : undefined;
      const path = request.url!;
      requests.push({ method: request.method!, path, body: value });
      let result: object = {};
      if (path.endsWith("/recall")) result = { results: [{ id: "returned-memory", text: "Fenced reference fact" }] };
      else if (path.endsWith("/memories") && request.method === "POST") {
        completed.add(value.operation_id);
        result = { operation_id: value.operation_id };
      } else if (path.includes("/operations/")) result = { status: completed.has(path.split("/").at(-1)!) ? "completed" : "pending" };
      else if (path.endsWith("/knowledge-base/tree")) result = { roots: [] };
      else if (path.includes("/knowledge-base/")) result = { id: "node-" + ++node };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const settings = join(root, "config.json");
  await writeFile(settings, JSON.stringify({ mode: "active", harness: "pi", dataDir: state,
    apiUrl: `http://127.0.0.1:${port}`, apiToken: "fixture-only", bankId: "fixture-bank", shadowBankId: "fixture-shadow" }));
  const mock = mockPi();
  const ctx = { cwd: workspace, mode: "tui", ui: { notify() {} }, sessionManager: { getSessionId: () => "http-session" } };
  try {
    registerHindsightIntegration(mock.pi as any, { hindsightEnabled: true, hindsightSettingsPath: settings,
      projectResolutionMode: "catalog", scopeCatalogDir: state }, (value) => syncScopeStoreMetadata(value, join(root, "projects-memory")));
    await mock.handlers.session_start({}, ctx);
    await mock.handlers.input({ text: "Remember this question", source: "interactive" }, ctx);
    const prompt = await mock.handlers.before_agent_start({ prompt: "Remember this question", systemPrompt: "base" }, ctx);
    assert.match(prompt.systemPrompt, /<memory-context>/);
    assert.match(prompt.systemPrompt, /not instructions/);
    await mock.handlers.turn_end({ message: { content: "Assistant response" } }, ctx);
    const result = await mock.tools.long_memory.execute("retain-call", { action: "retain", content: "Requested durable fact" }, undefined, undefined, ctx);
    assert.equal(result.details.success, true);
    await mock.tools.long_memory.execute("correct-call", { action: "correct", memory_id: "returned-memory", new_text: "Corrected fact" }, undefined, undefined, ctx);
    await mock.tools.long_memory.execute("forget-call", { action: "forget", memory_id: "returned-memory", reason: "Explicit test request" }, undefined, undefined, ctx);
    await mock.handlers.session_shutdown({}, ctx);
    const recall = requests.find((request) => request.path.endsWith("/recall"))!;
    assert.deepEqual(recall.body.tag_groups, [{ or: [{ tags: [scope.memoryTag], match: "all_strict" }] }]);
    const retains = requests.filter((request) => request.method === "POST" && request.path.endsWith("/memories"));
    assert.equal(retains.length, 2);
    for (const request of retains) {
      assert.match(request.path, /fixture-bank/);
      assert.deepEqual(request.body.items[0].tags, [scope.memoryTag]);
      assert.deepEqual(request.body.items[0].observation_scopes, [[scope.memoryTag]]);
    }
    const corrections = requests.filter((request) => request.method === "PATCH");
    assert.deepEqual(corrections.map((request) => request.body), [{ text: "Corrected fact", resolve_entities: false }, { state: "invalidated", reason: "Explicit test request" }]);
    const descriptor = JSON.parse(await readFile(join(root, "projects-memory/scope_http/.pi-memory-scope-store.json"), "utf8"));
    assert.equal(descriptor.scopeId, scope.scopeId);
    assert.deepEqual(await readdir(join(state, "outbox/pending")), []);
    await writeFile(join(root, "hermes-memory-config.json"), JSON.stringify({ hindsightEnabled: true,
      hindsightSettingsPath: settings, projectResolutionMode: "catalog", scopeCatalogDir: state,
      memoryMode: "legacy-inject", reviewEnabled: false, flushOnCompact: false, flushOnShutdown: false,
      autoConsolidate: false, correctionDetection: false, standingInstructionsEnabled: false }));
    const script = `
      import assert from "node:assert/strict";
      import extension from "./src/index.ts";
      const handlers = {}, tools = {};
      const pi = { on: (name, fn) => (handlers[name] ??= []).push(fn),
        registerTool: (tool) => tools[tool.name] = tool, registerCommand() {} };
      extension(pi);
      const ctx = { cwd: ${JSON.stringify(workspace)}, mode: "tui", ui: { notify() {} },
        sessionManager: { getSessionId: () => "main-session", getBranch: () => [], getSessionFile: () => undefined,
          getHeader: () => null, getEntries: () => [] } };
      for (const fn of handlers.session_start) await fn({}, ctx);
      assert.ok(tools.long_memory);
      const result = await tools.memory_add.execute("bounded", { target: "project", content: "Main factory Scope fact" }, undefined, undefined, ctx);
      assert.equal(result.details.success, true);
      for (const fn of handlers.session_shutdown) await fn({}, ctx);
    `;
    const processResult = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 15000,
      env: { ...process.env, PI_CODING_AGENT_DIR: root },
    });
    assert.equal(processResult.stderr, "");
    assert.match(await readFile(join(root, "projects-memory/scope_http/MEMORY.md"), "utf8"), /Main factory Scope fact/);
  } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
});
