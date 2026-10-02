import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ScopedHindsightProvider } from "../../src/hindsight/provider.js";
import { registerLongMemoryTool } from "../../src/hindsight/tools.js";
import { scope } from "./fixtures.js";

type Params = {
  action: "search" | "retain" | "correct" | "forget";
  query?: string;
  content?: string;
  memory_id?: string;
  new_text?: string;
  reason?: string;
};

function executor(provider: Partial<ScopedHindsightProvider>) {
  let execute:
    | ((id: string, params: Params, signal?: AbortSignal) => Promise<unknown>)
    | undefined;
  const pi = {
    registerTool(tool: { execute: NonNullable<typeof execute> }) {
      execute = tool.execute;
    },
  } as unknown as ExtensionAPI;
  registerLongMemoryTool(pi, async () => ({
    scope,
    provider: provider as ScopedHindsightProvider,
  }));
  return (params: Params) => {
    assert.ok(execute);
    return execute("call-1", params);
  };
}

test("long memory refuses empty required inputs before calling the provider", async () => {
  const execute = executor({});
  await assert.rejects(
    execute({ action: "search", query: " " }),
    /query is required/,
  );
  await assert.rejects(
    execute({ action: "retain", content: " " }),
    /content is required/,
  );
  await assert.rejects(
    execute({ action: "correct", new_text: "text" }),
    /memory_id is required/,
  );
  await assert.rejects(execute({ action: "forget" }), /memory_id is required/);
  await assert.rejects(
    execute({ action: "correct", memory_id: "id", new_text: " " }),
    /new_text is required/,
  );
});

test("long memory refuses to report queued retention as confirmed", async () => {
  let content = "";
  const execute = executor({
    enqueueExplicit: async (_scope, input) => {
      content = input.content;
    },
    drain: async () => ({ completed: 0, deferred: 1, failed: 0 }),
  });
  await assert.rejects(
    execute({ action: "retain", content: " fact " }),
    /queued but not confirmed/,
  );
  assert.equal(content, "fact");
});

test("completing a different queued job cannot falsely confirm the requested fact", async () => {
  const execute = executor({ enqueueExplicit: async () => {},
    drain: async () => ({ completed: 1, deferred: 0, failed: 0 }) });
  await assert.rejects(execute({ action: "retain", content: "Unconfirmed target fact" }), /queued but not confirmed/);
});

test("long memory correction preserves entity-resolution and reversible-forget contracts", async () => {
  const updates: Array<{ memoryId: string; request: unknown }> = [];
  const execute = executor({
    updateMemory: async (memoryId, request) => {
      updates.push({ memoryId, request });
      return {};
    },
  });
  await execute({
    action: "correct",
    memory_id: " id ",
    new_text: " authoritative ",
  });
  await execute({ action: "forget", memory_id: " id ", reason: " because " });
  assert.deepEqual(updates, [
    {
      memoryId: "id",
      request: { text: "authoritative", resolve_entities: false },
    },
    { memoryId: "id", request: { state: "invalidated", reason: "because" } },
  ]);
});
