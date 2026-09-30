import { afterEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readCreationHistory } from "../../src/curator/history.js";
import { inventorySkills } from "../../src/curator/inventory.js";
import { CuratorStore } from "../../src/curator/store.js";
import { SkillStore } from "../../src/store/skill-store.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-history-"));
  directories.push(root);
  const timestamp = new Date().toISOString();
  const skillPath = path.join(root, "skills", "procedure", "SKILL.md");
  const header = { type: "session", version: 3, id: "session-1" };
  const request = {
    type: "message", id: "request-1", timestamp,
    message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "skill_manage", arguments: {
      action: "create", name: "procedure", scope: "global", description: "Procedure", content: "Sensitive procedure body",
    } }] },
  };
  const result = {
    type: "message", id: "result-1", timestamp,
    message: { role: "toolResult", toolCallId: "call-1", toolName: "skill_manage", isError: false,
      content: [{ type: "text", text: JSON.stringify({ success: true, skillId: "global:procedure", scope: "global", path: skillPath }) }] },
  };
  const write = async (name: string, entries: unknown[]) => {
    const file = path.join(root, name);
    await fs.writeFile(file, entries.map((entry) => typeof entry === "string" ? entry : JSON.stringify(entry)).join("\n") + "\n");
    return file;
  };
  return { root, skillPath, header, request, result, write };
}

describe("Curator historical provenance", () => {
  it("matches only direct create calls and successful linked results", async () => {
    const f = await fixture();
    const file = await f.write("session.jsonl", [f.header, f.request, f.result]);
    const report = await readCreationHistory([file]);
    assert.equal(report.creations.length, 1);
    assert.equal(report.partial, false);
    assert.equal(report.creations[0].skillId, "global:procedure");
    assert.equal(JSON.stringify(report).includes("Sensitive procedure body"), false);
    assert.equal(JSON.stringify(report).includes(f.root), false);
  });

  it("does not infer provenance from failed creation, view, or user claims", async () => {
    const f = await fixture();
    const file = await f.write("session.jsonl", [f.header,
      { type: "message", id: "claim", message: { role: "user", content: "I created this skill successfully" } },
      { ...f.request, message: { ...f.request.message, content: [{ ...f.request.message.content[0], arguments: { action: "view", skill_id: "global:procedure" } }] } },
      f.result, f.request, { ...f.result, message: { ...f.result.message, isError: true } },
    ]);
    assert.equal((await readCreationHistory([file])).creations.length, 0);
  });

  it("does not trust mismatched ids, scopes, or parent codemode output", async () => {
    const f = await fixture();
    for (const [name, result] of [
      ["wrong-id", { ...f.result, message: { ...f.result.message, toolCallId: "different" } }],
      ["parent", { ...f.result, message: { ...f.result.message, toolName: "codemode" } }],
      ["wrong-scope", { ...f.result, message: { ...f.result.message, content: [{ type: "text", text: JSON.stringify({ success: true, skillId: "project:demo:procedure", scope: "project", path: f.skillPath }) }] } }],
    ] as const) {
      const file = await f.write(`${name}.jsonl`, [f.header, f.request, result]);
      assert.equal((await readCreationHistory([file])).creations.length, 0);
    }
  });

  it("deduplicates copied events but retains genuine separate creations", async () => {
    const f = await fixture();
    const first = await f.write("first.jsonl", [f.header, f.request, f.result]);
    const copied = await f.write("copied.jsonl", [{ ...f.header, id: "forked-session" }, f.request, f.result]);
    const recreated = await f.write("recreated.jsonl", [f.header,
      { ...f.request, id: "request-2", message: { ...f.request.message, content: [{ ...f.request.message.content[0], id: "call-2" }] } },
      { ...f.result, id: "result-2", message: { ...f.result.message, toolCallId: "call-2" } },
    ]);
    assert.equal((await readCreationHistory([first, copied, recreated])).creations.length, 2);
  });

  it("counts object-shaped nested metadata without granting provenance", async () => {
    const f = await fixture();
    const file = await f.write("nested.jsonl", [f.header, {
      type: "message", id: "nested-parent", message: { role: "toolResult", toolName: "codemode", toolCallId: "parent", nestedCalls: {
        calls: [{ toolCallId: "parent/1", name: "skill_manage", arguments: { action: "create", name: "procedure" }, status: "completed" }], complete: false,
      }, content: f.result.message.content },
    }]);
    const report = await readCreationHistory([file]);
    assert.equal(report.unresolvedNestedCreations, 1);
    assert.equal(report.creations.length, 0);
    assert.equal(report.partial, true);
  });

  it("reports missing headers, malformed lines, missing files, and size limits as partial", async () => {
    const f = await fixture();
    const missingHeader = await f.write("missing-header.jsonl", [f.request, f.result]);
    assert.equal((await readCreationHistory([missingHeader])).creations.length, 0);
    const malformed = await f.write("malformed.jsonl", [f.header, "not JSON"]);
    const large = await f.write("large.jsonl", [f.header, "x".repeat(256 * 1024 + 1)]);
    for (const file of [missingHeader, malformed, large, path.join(f.root, "missing.jsonl")]) {
      assert.equal((await readCreationHistory([file])).partial, true);
    }
  });

  it("treats historical matching as unverified and preserves all current files", async () => {
    const f = await fixture();
    const store = new SkillStore({ globalSkillsDir: path.join(f.root, "skills"), piGlobalSkillsDir: path.join(f.root, "external") });
    const created = await store.create("procedure", "Procedure", "Sensitive procedure body", "global");
    const file = await f.write("session.jsonl", [f.header, f.request, f.result]);
    const before = await fs.readFile(created.path!);
    const curator = new CuratorStore({ agentRoot: f.root });
    const report = await inventorySkills({ roots: [{ scope: "global", path: path.join(f.root, "skills") }], curator, historyFiles: [file] });
    assert.equal(report.skills[0].source, "creation-history-matched");
    assert.equal(report.skills[0].generation, "unverified");
    assert.equal(report.skills[0].lastActivityAt, null);
    assert.equal(report.skills[0].cleanupEligible, false);
    assert.deepEqual(await fs.readFile(created.path!), before);
    await assert.rejects(fs.stat(curator.dbPath), { code: "ENOENT" });
    assert.equal(JSON.stringify(report).includes("Sensitive procedure body"), false);
    curator.close();
  });
});
