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
import { assertNoMemorySecrets } from "../../src/hindsight/content.js";

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
      assertNoMemorySecrets({ user, assistant });
      writes.push({ scope: scope.scopeId, user, assistant });
    },
  } as unknown as ScopedHindsightProvider;
  const pi = { on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => { handlers[name] = handler; },
    registerCommand() {}, registerTool() {} };
  createHindsightExtension({ config: { ...DEFAULT_CONFIG, mode: "active", dataDir }, provider,
    scopeResolver: (cwd) => resolveScope(cwd, { dataDir }) })(pi as any);
  const notifications: { message: string; level: string }[] = [];
  const context = (cwd: string, id: string) => ({ cwd, mode: "tui", ui: {
    notify(message: string, level: string) { notifications.push({ message, level }); },
  },
    sessionManager: { getSessionId: () => id } });
  return { handlers, writes, provider, notifications, release, first: context(first, "session-first"), second: context(second, "session-second") };
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

test("recall appends to structured prompt options without flattening sections", async () => {
  const f = await fixture();
  await f.handlers.session_start({}, f.first);
  const systemPromptOptions = { sections: [{ name: "base", content: "base" }], appendSystemPrompt: "existing" };
  const result = await f.handlers.before_agent_start({ prompt: "second question", systemPrompt: "base", systemPromptOptions }, f.first);
  assert.equal(result, undefined);
  assert.deepEqual(systemPromptOptions.sections, [{ name: "base", content: "base" }]);
  assert.match(systemPromptOptions.appendSystemPrompt, /scope_first/);
  assert.match(systemPromptOptions.appendSystemPrompt, /^existing/);
  await f.handlers.session_shutdown({}, f.first);
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

for (const source of ["user", "assistant"] as const) {
  test(`secret-bearing ${source} text skips automatic retention without breaking turn_end`, async () => {
    const f = await fixture();
    const secret = "Bearer " + "x".repeat(32);
    await f.handlers.session_start({}, f.first);
    const before = f.notifications.length;
    try {
      await f.handlers.input({ text: source === "user" ? secret : "safe question", source: "interactive" }, f.first);
      await assert.doesNotReject(() => f.handlers.turn_end({
        message: { role: "assistant", content: source === "assistant" ? secret : "safe answer" },
      }, f.first));
      assert.deepEqual(f.writes, []);
      const warnings = f.notifications.slice(before);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].level, "warning");
      assert.match(warnings[0].message, /skipped/i);
      assert.equal(warnings[0].message.includes(secret), false);
      await f.handlers.input({ text: "safe follow-up", source: "interactive" }, f.first);
      await f.handlers.turn_end({ message: { role: "assistant", content: "safe reply" } }, f.first);
      assert.deepEqual(f.writes, [{ scope: "scope_first", user: "safe follow-up", assistant: "safe reply" }]);
    } finally {
      await f.handlers.session_shutdown({}, f.first);
    }
  });
}

test("unexpected retention failures still propagate rather than being classified as secret rejections", async () => {
  const f = await fixture();
  const failure = new Error("unexpected storage failure");
  f.provider.enqueueTurn = async () => { throw failure; };
  await f.handlers.session_start({}, f.first);
  try {
    await f.handlers.input({ text: "safe question", source: "interactive" }, f.first);
    await assert.rejects(() => f.handlers.turn_end({ message: { role: "assistant", content: "safe answer" } }, f.first), (error) => error === failure);
  } finally {
    await f.handlers.session_shutdown({}, f.first);
  }
});
