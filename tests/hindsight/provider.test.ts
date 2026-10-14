import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/hindsight/config.js";
import type {
  HindsightClient,
  RecallRequest,
} from "../../src/hindsight/client.js";
import type { RetainOutbox } from "../../src/hindsight/outbox.js";
import { ScopedHindsightProvider } from "../../src/hindsight/provider.js";
import { scope } from "./fixtures.js";

test("provider sends a strict current-Scope filter by default", async () => {
  let request: RecallRequest | undefined;
  const client = {
    recall: async (_bank: string, value: RecallRequest) => {
      request = value;
      return { results: [{ text: "memory" }] };
    },
  } as unknown as HindsightClient;
  const provider = new ScopedHindsightProvider(
    DEFAULT_CONFIG,
    client,
    {} as RetainOutbox,
  );
  const outcome = await provider.recall("query", scope);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.memories.length, 1);
  assert.deepEqual(request?.tag_groups, [
    {
      or: [{ tags: [scope.scopeTag], match: "all_strict" }],
    },
  ]);
});

test("provider retains every turn under only the current scope tag", async () => {
  let item:
    | {
        tags?: string[];
        observation_scopes?: string[][];
        metadata?: Record<string, unknown>;
      }
    | undefined;
  const outbox = {
    enqueue: async (job: { item: typeof item }) => {
      item = job.item;
    },
  } as unknown as RetainOutbox;
  const provider = new ScopedHindsightProvider(
    DEFAULT_CONFIG,
    {} as HindsightClient,
    outbox,
  );
  await provider.enqueueTurn(
    scope,
    {
      sessionId: "session",
      turnId: "turn",
      harness: "test",
      timestamp: "2026-09-14T00:00:00.000Z",
    },
    "question",
    "answer",
  );
  assert.deepEqual(item?.tags, [scope.scopeTag]);
  assert.deepEqual(item?.observation_scopes, [[scope.scopeTag]]);
  assert.equal(item?.metadata?.scope_id, scope.scopeId);
  assert.equal(item?.metadata?.project_id, scope.projectId);
});

test("provider recall fails open", async () => {
  const client = {
    recall: async () => {
      throw new Error("offline");
    },
  } as unknown as HindsightClient;
  const provider = new ScopedHindsightProvider(
    DEFAULT_CONFIG,
    client,
    {} as RetainOutbox,
  );
  const outcome = await provider.recall("query", scope);
  assert.deepEqual(outcome.memories, []);
  assert.equal(outcome.error, "offline");
});
