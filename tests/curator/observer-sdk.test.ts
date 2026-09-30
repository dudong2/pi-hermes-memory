import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SkillStore } from "../../src/store/skill-store.js";
import { CuratorStore } from "../../src/curator/store.js";
import { registerCuratorObserver } from "../../src/curator/observer-hooks.js";
import type { ObserverUserMessage } from "../../src/curator/observer.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-sdk-"));
  const curator = new CuratorStore({ agentRoot: root });
  const skills = new SkillStore({ globalSkillsDir: path.join(root, "skills"), piGlobalSkillsDir: path.join(root, "external"), curator });
  const created = await skills.create("sdk-procedure", "SDK workflow", "## Procedure\n1. Verify SDK delivery", "global");
  assert.equal(created.success, true);
  type Handler = (event: never, ctx: ExtensionContext) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const pi = { on: (event: string, handler: Handler) => { handlers.set(event, handler); } } as unknown as ExtensionAPI;
  const observer = registerCuratorObserver(pi, curator, skills);
  let sessionId = "sdk-temporary-session";
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
  const emit = async (name: string, event: object) => {
    const handler = handlers.get(name);
    assert.ok(handler, `handler ${name}`);
    return handler(event as never, ctx);
  };
  await emit("session_start", { type: "session_start", reason: "startup" });
  const delivered: ObserverUserMessage[] = [];
  // Exercise the installed SDK's actual prompt/expansion/queue methods. Only the
  // agent delivery endpoint is stubbed; no model, auth storage, or live UI is used.
  const session = Object.create(AgentSession.prototype) as AgentSession;
  Object.assign(session, {
    agent: { state: { isStreaming: true }, steer: (message: ObserverUserMessage) => delivered.push(message), followUp: (message: ObserverUserMessage) => delivered.push(message) },
    _steeringMessages: [], _followUpMessages: [], _emit: () => {},
    _resourceLoader: {
      getSkills: () => ({ skills: [{ name: "sdk-procedure", filePath: created.path, baseDir: path.dirname(created.path!) }], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
    },
    _extensionRunner: {
      getCommand: () => undefined, hasHandlers: (name: string) => name === "input", emitError: () => {},
      emitInput: async (text: string, _images: unknown, source: string, streamingBehavior: string) => {
        await emit("input", { type: "input", text, source, streamingBehavior });
        return { action: "continue" };
      },
    },
  });
  cleanup.push(async () => {
    await observer.close();
    curator.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, curator, created, emit, delivered, session, changeSession: () => { sessionId = "sdk-resumed-session"; } };
}

describe("Curator SDK event adapter", () => {
  for (const streamingBehavior of ["steer", "followUp"] as const) {
    it(`confirms a queued RPC /skill command through SDK ${streamingBehavior}`, async () => {
      const f = await fixture();
      await f.session.prompt("/skill:sdk-procedure argument", { source: "rpc", streamingBehavior });
      assert.equal(f.curator.activities().length, 0);
      assert.equal(f.delivered.length, 1);
      await f.emit("message_start", { type: "message_start", message: f.delivered[0] });
      assert.equal(f.curator.activities()[0].kind, "skill-command");
      assert.ok(f.curator.list()[0].lastActivityAt);
      await f.emit("message_start", { type: "message_start", message: f.delivered[0] });
      assert.equal(f.curator.activities().length, 1);
      await f.emit("session_shutdown", { type: "session_shutdown" });
      assert.equal(f.curator.observations().runs[0].state, "closed");
    });
  }

  for (const method of ["steer", "followUp"] as const) {
    it(`marks direct SDK ${method} without input evidence as an observation gap`, async () => {
      const f = await fixture();
      await f.session[method]("/skill:sdk-procedure");
      await f.emit("message_start", { type: "message_start", message: f.delivered[0] });
      assert.equal(f.curator.activities().length, 0);
      assert.equal(f.curator.list()[0].lastActivityAt, null);
      assert.ok(f.curator.observations().gaps.some((gap) => gap.reason === "unconfirmed-skill-command"));
    });
  }

  it("routes nested tool events, does not modify results, and rebinds changed sessions", async () => {
    const f = await fixture();
    const call = { type: "tool_call", toolName: "read", toolCallId: "parent/1", input: { path: f.created.path } };
    await f.emit("tool_call", call);
    const result = { ...call, type: "tool_result", isError: false, content: [{ type: "text", text: "SDK read output" }], details: {} };
    assert.equal(await f.emit("tool_result", result), undefined);
    assert.equal(result.content[0].text, "SDK read output");
    await f.emit("message_end", { type: "message_end", message: { role: "toolResult", nestedCalls: { complete: true, calls: [{ name: "read", toolCallId: "parent/1", arguments: call.input, status: "completed" }] } } });
    assert.equal(f.curator.observations().gaps.length, 0);
    f.changeSession();
    const next = { ...call, toolCallId: "parent/2" };
    await f.emit("tool_call", next);
    await f.emit("tool_result", { ...result, toolCallId: "parent/2" });
    assert.equal(f.curator.activities().length, 2);
    assert.equal(f.curator.observations().runs.length, 2);
  });
});
