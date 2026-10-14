import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../../src/hindsight/config.js";
import { syncScopeStoreMetadata } from "../../src/hindsight/store-metadata.js";
import { createHindsightExtension as createMemoryOrchestratorExtension } from "../../src/hindsight/runtime.js";
import type { ScopedHindsightProvider } from "../../src/hindsight/provider.js";
import {
  createProject,
  createScope,
  loadScopeCatalog,
} from "../../src/scope/catalog.js";
import type { ResolvedScope } from "../../src/scope/resolver.js";

async function ensureHermesScopeStore(scope: ResolvedScope, agentRoot: string) {
  await syncScopeStoreMetadata(scope, join(agentRoot, "projects-memory"));
}

function provider(knowledgeScopes: ResolvedScope[]) {
  return {
    bankId: () => "test-bank",
    counts: async () => ({ pending: 0, processing: 0, failed: 0 }),
    recall: async () => ({ memories: [], plan: { tagGroups: [] } }),
    enqueueTurn: async () => undefined,
    enqueueExplicit: async () => undefined,
    updateMemory: async () => ({}),
    ensureKnowledgeViews: async (scope: ResolvedScope) => {
      knowledgeScopes.push(scope);
      return { createdFolders: 0, createdPages: 0 };
    },
    drain: async () => ({ completed: 0, deferred: 0, failed: 0 }),
  } as unknown as ScopedHindsightProvider;
}

function runtime(
  dataDir: string,
  memoryProvider: ScopedHindsightProvider,
  syncHermesScopeStore: (scope: ResolvedScope) => Promise<unknown>,
) {
  const commands = new Map<
    string,
    { handler(args: string, ctx: ExtensionContext): Promise<void> }
  >();
  const handlers = new Map<string, Function[]>();
  const extensionEvents = new Map<string, Function[]>();
  const pi = {
    events: {
      on(name: string, handler: Function) {
        extensionEvents.set(name, [
          ...(extensionEvents.get(name) ?? []),
          handler,
        ]);
      },
      emit(name: string, value: unknown) {
        for (const handler of extensionEvents.get(name) ?? []) handler(value);
      },
    },
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool() {},
    registerCommand(name: string, command: unknown) {
      commands.set(
        name,
        command as {
          handler(args: string, ctx: ExtensionContext): Promise<void>;
        },
      );
    },
  } as unknown as ExtensionAPI;
  createMemoryOrchestratorExtension({
    config: { ...DEFAULT_CONFIG, mode: "shadow", dataDir },
    provider: memoryProvider,
    syncHermesScopeStore,
  })(pi);
  return commands;
}

function context(
  cwd: string,
  projectChoice: string,
  notifications: Array<{ message: string; level: string }>,
  reloads: { count: number },
): ExtensionContext {
  return {
    cwd,
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      select: async () => projectChoice,
      confirm: async () => true,
      notify: (message: string, level: string) =>
        notifications.push({ message, level }),
    },
    reload: async () => {
      reloads.count++;
    },
  } as unknown as ExtensionContext;
}

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const scopeRoot = join(root, "service");
  const dataDir = join(root, "state");
  const agentRoot = join(root, "agent");
  const source = await createProject(dataDir, "Source");
  const target = await createProject(dataDir, "Target");
  const registered = await createScope(dataDir, {
    root: scopeRoot,
    projectId: source.projectId,
    name: "service",
  });
  return { scopeRoot, dataDir, agentRoot, source, target, registered };
}

test("/memory-reassign-scope reassigns the current Scope and reloads extensions", async () => {
  const setup = await fixture("memory-reassign-command-");
  const knowledgeScopes: ResolvedScope[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const reloads = { count: 0 };
  const commands = runtime(setup.dataDir, provider(knowledgeScopes), (scope) =>
    ensureHermesScopeStore(scope, setup.agentRoot),
  );

  await commands
    .get("memory-reassign-scope")
    ?.handler("", context(setup.scopeRoot, "Target", notifications, reloads));

  const catalog = await loadScopeCatalog(setup.dataDir);
  assert.equal(
    catalog.scopes[setup.registered.scopeId]?.projectId,
    setup.target.projectId,
  );
  assert.equal(catalog.projects[setup.source.projectId], undefined);
  assert.ok(catalog.projects[setup.target.projectId]);
  assert.equal(
    catalog.scopes[setup.registered.scopeId]?.memoryTag,
    setup.registered.memoryTag,
  );
  const metadata = JSON.parse(
    await readFile(
      join(
        setup.agentRoot,
        "projects-memory",
        setup.registered.scopeId,
        ".pi-memory-scope-store.json",
      ),
      "utf8",
    ),
  );
  assert.equal(metadata.qualifiedName, "Target/service");
  assert.equal(knowledgeScopes.at(-1)?.projectName, "Target");
  assert.equal(reloads.count, 1);
  assert.ok(
    notifications.some(({ message }) =>
      /Source\/service → Target\/service/.test(message),
    ),
  );
});

test("/memory-reassign-scope rolls catalog membership back when Hermes metadata fails", async () => {
  const setup = await fixture("memory-reassign-command-rollback-");
  const notifications: Array<{ message: string; level: string }> = [];
  const reloads = { count: 0 };
  const commands = runtime(setup.dataDir, provider([]), async (scope) => {
    if (scope.projectId === setup.target.projectId) throw new Error("Hermes metadata unavailable");
  });

  await commands
    .get("memory-reassign-scope")
    ?.handler(
      "Target",
      context(setup.scopeRoot, "Target", notifications, reloads),
    );

  const catalog = await loadScopeCatalog(setup.dataDir);
  assert.equal(
    catalog.scopes[setup.registered.scopeId]?.projectId,
    setup.source.projectId,
  );
  assert.equal(reloads.count, 0);
  assert.ok(
    notifications.some(
      ({ message, level }) =>
        level === "error" && /Hermes metadata unavailable/.test(message),
    ),
  );
});
