import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const script = path.resolve("scripts/curator-usage.mjs");
const entry = (id: string, timestamp: string, message: Record<string, unknown>) => ({ type: "message", id, timestamp, message });

test("fixed cohort tracks successful Pi calls without promoting any skill to deletion authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curator-usage-"));
  const run = (arg: string) => execFileSync(process.execPath, [script, arg], {
    env: { ...process.env, PI_CODING_AGENT_DIR: root }, encoding: "utf8",
  });
  try {
    const globalDir = path.join(root, "pi-hermes-memory", "skills", "example");
    const projectDir = path.join(root, "projects-memory", "scope_one", "skills", "project-example");
    const manifestDir = path.join(root, "pi-hermes-memory", "curator");
    const sessionsDir = path.join(root, "sessions", "a");
    for (const dir of [globalDir, projectDir, manifestDir, sessionsDir]) fs.mkdirSync(dir, { recursive: true });
    const globalFile = path.join(globalDir, "SKILL.md");
    const projectFile = path.join(projectDir, "SKILL.md");
    fs.writeFileSync(globalFile, "# Global");
    fs.writeFileSync(projectFile, "# Project");
    assert.deepEqual(JSON.parse(run("--init")), { initialized: true, skills: 2, noDeletionAuthority: true });
    const manifestPath = path.join(manifestDir, "usage-cohort.json");
    const baseline = fs.readFileSync(manifestPath, "utf8");
    const stamp = new Date(Date.parse(JSON.parse(baseline).start) + 1000).toISOString();
    const messages = [
      { type: "session", version: 3, id: "session-one", cwd: root },
      entry("call", stamp, { role: "assistant", content: [
        { type: "toolCall", id: "one", name: "read", arguments: { path: globalFile } },
        { type: "toolCall", id: "two", name: "read", arguments: { path: projectFile } },
        { type: "toolCall", id: "three", name: "skill_manage", arguments: { action: "view", skill_id: "global:example" } },
      ] }),
      entry("ok", stamp, { role: "toolResult", toolName: "read", toolCallId: "one", isError: false, content: [] }),
      entry("failed", stamp, { role: "toolResult", toolName: "read", toolCallId: "two", isError: true, content: [] }),
      entry("view", stamp, { role: "toolResult", toolName: "skill_manage", toolCallId: "three", isError: false,
        content: [{ type: "text", text: JSON.stringify({ success: true, skillId: "global:example", path: globalFile }) }] }),
      entry("delivered", stamp, { role: "user", content: `<skill name="project-example" location="${projectFile}">\nBody\n</skill>` }),
    ];
    fs.writeFileSync(path.join(sessionsDir, "one.jsonl"), messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    const nestedDir = path.join(sessionsDir, "deeper");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, "two.jsonl"), [
      { type: "session", version: 3, id: "session-two", cwd: root },
      entry("nested", stamp, { role: "toolResult", toolName: "codemode", toolCallId: "parent", isError: false, nestedCalls: {
        complete: true, calls: [
          { id: "child-1", name: "read", status: "ok", arguments: { path: globalFile } },
          { id: "child-2", name: "read", status: "error", arguments: { path: globalFile } },
          { id: "child-3", name: "skill_manage", status: "ok", arguments: { action: "view", skill_id: "global:example" } },
        ],
      } }),
    ].map((message) => JSON.stringify(message)).join("\n") + "\n");
    const report = JSON.parse(run("--report"));
    assert.equal(report.sessionFiles, 2);
    assert.equal(report.skillCount, 2);
    assert.equal(report.observedSkills, 1);
    assert.equal(report.possibleDeliverySkills, 1);
    assert.deepEqual(report.skills.map(({ id, read, view, deliveryCandidate }: { id: string; read: number; view: number; deliveryCandidate: number }) => ({ id, read, view, deliveryCandidate })), [
      { id: "global:example", read: 2, view: 1, deliveryCandidate: 0 },
      { id: "project:scope_one:project-example", read: 0, view: 0, deliveryCandidate: 1 },
    ]);
    const second = spawnSync(process.execPath, [script, "--init"], { env: { ...process.env, PI_CODING_AGENT_DIR: root } });
    assert.notEqual(second.status, 0);
    assert.equal(fs.readFileSync(manifestPath, "utf8"), baseline);
    assert.equal(fs.existsSync(path.join(manifestDir, "curator.db")), false);
    assert.equal(fs.readFileSync(globalFile, "utf8"), "# Global");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
