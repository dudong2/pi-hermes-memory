import assert from "node:assert/strict";
import test from "node:test";
import { formatProjectMemoryMirror, projectMemoryMirrorFromResult } from "../../src/hindsight/mirror.js";

const success = { success: true, target: "project" };

test("mirrors successful project add", () => {
  const mirror = projectMemoryMirrorFromResult({
    toolName: "memory_add",
    toolCallId: "call-1",
    input: { target: "project", content: "Use pnpm" },
    details: success,
  });
  assert.deepEqual(mirror, {
    action: "add",
    content: "Use pnpm",
    identity: "bounded-memory:call-1",
  });
});

test("replace mirror preserves correction provenance", () => {
  const mirror = projectMemoryMirrorFromResult({
    toolName: "memory_replace",
    toolCallId: "call-2",
    input: { target: "project", old_text: "Use yarn", content: "Use pnpm" },
    details: success,
  });
  assert.ok(mirror);
  const text = formatProjectMemoryMirror(mirror!);
  assert.match(text, /Previous text: Use yarn/);
  assert.match(text, /New authoritative text: Use pnpm/);
  assert.match(text, /supersedes/);
});

test("does not mirror remove, global, failed, or errored operations", () => {
  const events = [
    { toolName: "memory_remove", toolCallId: "1", input: { target: "project", old_text: "x" }, details: success },
    { toolName: "memory_add", toolCallId: "2", input: { target: "memory", content: "x" }, details: { success: true, target: "memory" } },
    { toolName: "memory_add", toolCallId: "3", input: { target: "project", content: "x" }, details: { success: false, target: "project" } },
    { toolName: "memory_add", toolCallId: "4", input: { target: "project", content: "x" }, details: success, isError: true },
    { toolName: "memory_add", toolCallId: "5", input: { target: "project", content: "" }, details: success },
  ];
  assert.deepEqual(events.map(projectMemoryMirrorFromResult), [null, null, null, null, null]);
});
