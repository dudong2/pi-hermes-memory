import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { SkillStore } from "../../src/store/skill-store.js";
import { parseFrontmatter } from "../../src/store/skill-utils.js";
import { CuratorStore } from "../../src/curator/store.js";
import { CuratorObserver } from "../../src/curator/observer.js";
import type { ObserverToolCall, ObserverToolResult } from "../../src/curator/observer.js";

const fixtures: { root: string; curator: CuratorStore; observer: CuratorObserver }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.observer.close();
    f.curator.close();
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-observer-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const curator = new CuratorStore({ agentRoot: root, now: () => now });
  const globalRoot = path.join(root, "global", "skills");
  const projectRoot = path.join(root, "projects", "demo", "skills");
  const store = new SkillStore({ globalSkillsDir: globalRoot, piGlobalSkillsDir: path.join(root, "external"), projectSkillsDir: projectRoot, projectName: "demo", curator });
  const created = await store.create("managed-build", "Managed build procedure", "## Procedure\n1. Check build logs", "global");
  assert.equal(created.success, true);
  const observer = new CuratorObserver(curator, () => [
    { scope: "global", path: globalRoot }, { scope: "project", path: projectRoot, projectName: "demo" },
  ]);
  fixtures.push({ root, curator, observer });
  await observer.start("temporary-session");
  return {
    root, curator, observer, store, created, globalRoot,
    tick: (milliseconds = 1000) => { now = new Date(now.getTime() + milliseconds); return now.toISOString(); },
    read: (id = "read-1"): ObserverToolCall => ({ toolName: "read", toolCallId: id, input: { path: created.path } }),
    result: (call: ObserverToolCall, isError = false): ObserverToolResult => ({ ...call, isError, content: [{ type: "text", text: "body exposed" }] }),
    block: async () => {
      const body = parseFrontmatter(await fs.readFile(created.path!, "utf8")).body.trim();
      return `<skill name="managed-build" location="${created.path}">\nReferences are relative to ${path.dirname(created.path!)}.\n\n${body}\n</skill>`;
    },
  };
}

describe("Curator activity observer", () => {
  it("records successful reads but not listing or internal inventory reads", async () => {
    const f = await fixture();
    await f.store.loadIndex();
    await f.store.loadSkill(f.created.skillId!);
    assert.equal(f.curator.list()[0].lastActivityAt, null);
    const call = f.read();
    await f.observer.onToolCall(call, f.root);
    const stamp = f.tick();
    await f.observer.onToolResult(f.result(call), f.root);
    assert.equal(f.curator.list()[0].lastActivityAt, stamp);
  });

  it("does not count failed reads or successful list-only view", async () => {
    const f = await fixture();
    const call = f.read();
    await f.observer.onToolCall(call, f.root);
    await f.observer.onToolResult(f.result(call, true), f.root);
    const list = { toolName: "skill_manage", toolCallId: "list", input: { action: "view" } };
    await f.observer.onToolCall(list, f.root);
    await f.observer.onToolResult({ ...list, isError: false, content: [{ type: "text", text: '{"success":true,"skills":[]}' }] }, f.root);
    assert.equal(f.curator.list()[0].lastActivityAt, null);
  });

  it("requires a successful specific view result, not merely isError:false", async () => {
    const f = await fixture();
    const call = { toolName: "skill_manage", toolCallId: "view-failed", input: { action: "view", skill_id: f.created.skillId } };
    await f.observer.onToolCall(call, f.root);
    await f.observer.onToolResult({ ...call, isError: false, content: [{ type: "text", text: '{"success":false}' }] }, f.root);
    assert.equal(f.curator.list()[0].lastActivityAt, null);
    const next = { ...call, toolCallId: "view-success" };
    await f.observer.onToolCall(next, f.root);
    const stamp = f.tick();
    const doc = await f.store.loadSkill(f.created.skillId!);
    await f.observer.onToolResult({ ...next, isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, ...doc }) }] }, f.root);
    assert.equal(f.curator.list()[0].lastActivityAt, stamp);
  });

  it("deduplicates result delivery and accepts nested per-child callbacks", async () => {
    const f = await fixture();
    const call = f.read("parent/child-1");
    await f.observer.onToolCall(call, f.root);
    const stamp = f.tick();
    await f.observer.onToolResult(f.result(call), f.root);
    f.tick();
    await f.observer.onToolResult(f.result(call), f.root);
    assert.equal(f.curator.list()[0].lastActivityAt, stamp);
  });

  it("does not enroll external files through reads", async () => {
    const f = await fixture();
    const plain = new SkillStore({ globalSkillsDir: f.globalRoot, piGlobalSkillsDir: path.join(f.root, "external") });
    const external = await plain.create("external-billing", "External billing workflow", "body", "global");
    const call = { toolName: "read", toolCallId: "outside", input: { path: external.path } };
    await f.observer.onToolCall(call, f.root);
    await f.observer.onToolResult(f.result(call), f.root);
    assert.equal(f.curator.list().length, 1);
    assert.equal(f.curator.list()[0].lastActivityAt, null);
  });

  it("never assigns an old read to a recreated generation", async () => {
    const f = await fixture();
    const call = f.read();
    await f.observer.onToolCall(call, f.root);
    await f.store.delete(f.created.skillId!);
    await f.store.create("managed-build", "Managed build procedure", "## Procedure\n1. Check build logs", "global");
    await f.observer.onToolResult(f.result(call), f.root);
    assert.ok(f.curator.list().every((row) => row.lastActivityAt === null));
  });

  it("records only a delivered, content-verified explicit skill command", async () => {
    const f = await fixture();
    await f.observer.onInput({ text: "/skill:managed-build", source: "rpc", streamingBehavior: "followUp" }, f.root);
    assert.equal(f.curator.list()[0].lastActivityAt, null);
    const stamp = f.tick();
    await f.observer.onUserMessage({ role: "user", timestamp: 1, content: [{ type: "text", text: await f.block() }] });
    assert.equal(f.curator.list()[0].lastActivityAt, stamp);
  });

  it("does not treat a user-pasted skill block as confirmed invocation", async () => {
    const f = await fixture();
    await f.observer.onUserMessage({ role: "user", timestamp: 1, content: await f.block() });
    assert.equal(f.curator.list()[0].lastActivityAt, null);
  });

  it("keeps distinct invocations when a provider reuses a completed toolCallId", async () => {
    const f = await fixture();
    const call = f.read("reused-provider-id");
    for (let i = 0; i < 2; i++) {
      await f.observer.onToolCall(call, f.root);
      f.tick();
      await f.observer.onToolResult(f.result(call), f.root);
    }
    assert.equal(f.curator.activities().length, 2);
  });

  it("never decreases last activity when the clock moves backwards", async () => {
    const f = await fixture();
    const first = f.read();
    await f.observer.onToolCall(first, f.root);
    const stamp = f.tick();
    await f.observer.onToolResult(f.result(first), f.root);
    const second = f.read("read-2");
    await f.observer.onToolCall(second, f.root);
    f.tick(-500);
    await f.observer.onToolResult(f.result(second), f.root);
    assert.equal(f.curator.list()[0].lastActivityAt, stamp);
    assert.equal(f.curator.observations().runs[0].state, "faulted");
  });

  it("records faults without failing the original result or persisting content", async () => {
    const f = await fixture();
    const call = f.read();
    await f.observer.onToolCall(call, f.root);
    const result = f.result(call);
    const before = JSON.stringify(result);
    f.curator.recordActivity = () => { throw new Error("private error details must not be stored"); };
    await assert.doesNotReject(f.observer.onToolResult(result, f.root));
    assert.equal(JSON.stringify(result), before);
    await f.observer.close();
    const observation = f.curator.observations();
    assert.equal(observation.runs[0].state, "faulted");
    assert.equal(observation.gaps[0].reason, "observer-error");
    assert.equal(JSON.stringify(observation).includes("private error details"), false);
    assert.equal(JSON.stringify(observation).includes("temporary-session"), false);
    assert.equal(JSON.stringify(f.curator.activities()).includes("body exposed"), false);
  });

  it("does not mistake unobserved nested metadata for successful activity", async () => {
    const f = await fixture();
    await f.observer.onNestedResult({ complete: false, calls: [{ name: "read", toolCallId: "missing/child", arguments: { path: f.created.path }, status: "completed" }] });
    assert.equal(f.curator.list()[0].lastActivityAt, null);
    assert.deepEqual(new Set(f.curator.observations().gaps.map((gap) => gap.reason)), new Set(["incomplete-nested-calls", "unobserved-nested-call"]));
  });

  it("preserves unfinished observations as gaps and closes only the current run", async () => {
    const f = await fixture();
    await f.observer.onToolCall(f.read(), f.root);
    await f.observer.close();
    const observation = f.curator.observations();
    assert.equal(observation.runs[0].state, "faulted");
    assert.ok(observation.runs[0].endedAt);
    assert.ok(observation.gaps.some((gap) => gap.reason === "pending-at-session-end"));
    const restarted = new CuratorObserver(f.curator, () => []);
    await restarted.start("resumed-session");
    await restarted.close();
    assert.equal(f.curator.observations().runs.length, 2);
  });

  it("starts a new observation epoch even when ending the old one fails", async () => {
    const f = await fixture();
    const previousRun = f.curator.observations().runs[0].runId;
    const end = f.curator.endObservation.bind(f.curator);
    f.curator.endObservation = () => { throw new Error("failed close"); };
    await f.observer.start("new-session");
    f.curator.endObservation = end;
    const call = f.read();
    await f.observer.onToolCall(call, f.root);
    f.tick();
    await f.observer.onToolResult(f.result(call), f.root);
    assert.notEqual(f.curator.activities()[0].runId, previousRun);
  });

  it("does not count a failed or altered expansion", async () => {
    const f = await fixture();
    await f.observer.onInput({ text: "/skill:managed-build", source: "interactive" }, f.root);
    await f.observer.onUserMessage({ role: "user", timestamp: 1, content: "/skill:managed-build" });
    assert.equal(f.curator.list()[0].lastActivityAt, null);
    await f.observer.onInput({ text: "/skill:managed-build", source: "interactive" }, f.root);
    await f.observer.onUserMessage({ role: "user", timestamp: 2, content: (await f.block()).replace("Check build logs", "different procedure") });
    assert.equal(f.curator.list()[0].lastActivityAt, null);
  });
});
