import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Each test file runs in its own process: bind the extension's agent root to a fixture.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-no-curator-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { default: registerExtension } = await import("../src/index.js");

test("manual skill management works without any Curator command, ledger or generation marker", async () => {
  const handlers: Record<string, Array<(event: any, ctx: any) => Promise<any>>> = {};
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  try {
    await fs.writeFile(path.join(root, "hermes-memory-config.json"), JSON.stringify({
      lazyInitialization: true, reviewEnabled: false, correctionDetection: false,
      curatorEnabled: true, curatorPaused: false,
    }));
    registerExtension({
      on(name: string, handler: any) { (handlers[name] ??= []).push(handler); },
      registerTool(tool: any) { tools[tool.name] = tool; },
      registerCommand(name: string, command: any) { commands[name] = command; },
    } as any);
    assert.equal(commands["memory-curator"], undefined);
    assert.ok(tools.skill_manage);
    const ctx = { cwd: root, hasUI: false, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
    for (const handler of handlers.session_start ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
    const result = await tools.skill_manage.execute("manual", { action: "create", name: "manual-retained",
      description: "A reusable manual skill", scope: "global", content: "## Procedure\n1. Inspect the state." },
    undefined, undefined, ctx);
    assert.equal(result.details.success, true);
    const file = path.join(root, "pi-hermes-memory", "skills", "manual-retained", "SKILL.md");
    assert.match(await fs.readFile(file, "utf8"), /manual-retained/);
    assert.doesNotMatch(await fs.readFile(file, "utf8"), /pi-hermes-generation/);
    await assert.rejects(fs.stat(path.join(root, "pi-hermes-memory", "curator")), { code: "ENOENT" });
    for (const handler of handlers.session_shutdown ?? []) await handler({ type: "session_shutdown" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
