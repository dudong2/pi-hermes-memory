import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createProject, createScope } from "../../src/scope/catalog.js";
import { resolveScope } from "../../src/scope/resolver.js";
import { DEFAULT_CONFIG } from "../../src/hindsight/config.js";
import { createHindsightExtension } from "../../src/hindsight/runtime.js";
import type { ScopedHindsightProvider } from "../../src/hindsight/provider.js";
import { tempRoot } from "../scope/fixtures.js";

async function fixture() {
  const root = await tempRoot("hindsight-session-isolation-");
  const dataDir = join(root, "catalog");
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first);
  await mkdir(second);
  const project = await createProject(dataDir, "Product");
  await createScope(dataDir, { root: first, projectId: project.projectId, name: "First", scopeId: "scope_first" });
  await createScope(dataDir, { root: second, projectId: project.projectId, name: "Second", scopeId: "scope_second" });
  const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
  const writes: { scope: string; user: string; assistant: string }[] = [];
  let release!: () => void;
  const deferred = new Promise<void>((done) => { release = done; });
  const provider = {
    bankId: () => "test-bank",
    recall: async (query: string, scope: { scopeId: string }) => {
      if (query === "first question") await deferred;
      return { memories: [{ id: scope.scopeId, text: `Reference from ${scope.scopeId}` }],
        plan: { tags: [], tagGroups: [], expandedScopes: [], expandedRepositories: [], workspaceWide: false } };
    },
    drain: async () => ({ completed: 0, deferred: 0, failed: 0 }),
    ensureKnowledgeViews: async () => ({ createdFolders: 0, createdPages: 0 }),
    enqueueTurn: async (scope: { scopeId: string }, _identity: unknown, user: string, assistant: string) => {
      writes.push({ scope: scope.scopeId, user, assistant });
    },
  } as unknown as ScopedHindsightProvider;
  const pi = { on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => { handlers[name] = handler; },
    registerCommand() {}, registerTool() {} };
  createHindsightExtension({ config: { ...DEFAULT_CONFIG, mode: "active", dataDir }, provider,
    scopeResolver: (cwd) => resolveScope(cwd, { dataDir }) })(pi as any);
  const context = (cwd: string, id: string) => ({ cwd, mode: "tui", ui: { notify() {} },
    sessionManager: { getSessionId: () => id } });
  return { handlers, writes, release, first: context(first, "session-first"), second: context(second, "session-second") };
}

test("a late recall from the previous session cannot inject into the replacement session", async () => {
  const f = await fixture();
  await f.handlers.session_start({}, f.first);
  const previous = f.handlers.before_agent_start({ prompt: "first question", systemPrompt: "base" }, f.first);
  await f.handlers.session_start({}, f.second);
  f.release();
  assert.equal(await previous, undefined);
  const current = await f.handlers.before_agent_start({ prompt: "second question", systemPrompt: "base" }, f.second);
  assert.match(current.systemPrompt, /scope_second/);
  assert.doesNotMatch(current.systemPrompt, /scope_first/);
  await f.handlers.session_shutdown({}, f.second);
});

test("a stale callback cannot write the new session user text under the old Scope", async () => {
  const f = await fixture();
  await f.handlers.session_start({}, f.first);
  await f.handlers.input({ text: "first question", source: "interactive" }, f.first);
  await f.handlers.session_start({}, f.second);
  await f.handlers.input({ text: "second question", source: "interactive" }, f.second);
  await f.handlers.before_agent_start({ prompt: "second question", systemPrompt: "base" }, f.second);
  f.release();
  await f.handlers.turn_end({ message: { role: "assistant", content: "Old completion" } }, f.first);
  await f.handlers.turn_end({ message: { role: "assistant", content: "New completion" } }, f.second);
  assert.deepEqual(f.writes, [{ scope: "scope_second", user: "second question", assistant: "New completion" }]);
  await f.handlers.session_shutdown({}, f.second);
  await f.handlers.turn_end({ message: { role: "assistant", content: "After shutdown" } }, f.second);
  assert.equal(f.writes.length, 1);
});
