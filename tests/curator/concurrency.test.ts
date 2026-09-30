import { it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CuratorStore } from "../../src/curator/store.js";
import { inventorySkills } from "../../src/curator/inventory.js";

it("serializes competing creation across two Pi processes", { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-concurrency-"));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const code = `
    import { SkillStore } from './src/store/skill-store.ts';
    import { CuratorStore } from './src/curator/store.ts';
    const root = ${JSON.stringify(root)};
    const curator = new CuratorStore({ agentRoot: root });
    const skills = new SkillStore({ globalSkillsDir: root + '/skills', piGlobalSkillsDir: root + '/external', curator });
    await new Promise(resolve => { process.stdin.once('data', resolve); process.stdout.write('ready\\n'); });
    try {
      const result = await skills.create('contested', 'Contested procedure', 'body', 'global');
      process.stdout.write('result:' + JSON.stringify(result) + '\\n');
    } finally { curator.close(); process.stdin.destroy(); }
  `;
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { cwd: repo, stdio: "pipe" });
    let output = "";
    let errors = "";
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("ready\n")) readyResolve();
    });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    const done = new Promise<{ output: string; errors: string; code: number | null }>((resolve, reject) => {
      child.once("error", (error) => { readyReject(error); reject(error); });
      child.once("close", (exitCode) => {
        if (!output.includes("ready\n")) readyReject(new Error(errors || "child exited before ready"));
        resolve({ output, errors, code: exitCode });
      });
    });
    return { child, ready, done };
  });
  try {
    await Promise.all(children.map((child) => child.ready));
    for (const child of children) child.child.stdin.end("start\n");
    const outcomes = await Promise.all(children.map((child) => child.done));
    const results = outcomes.map((outcome) => {
      assert.equal(outcome.code, 0, outcome.errors);
      const line = outcome.output.split("\n").find((value) => value.startsWith("result:"));
      assert.ok(line);
      return JSON.parse(line.slice(7)) as { success: boolean };
    });
    assert.equal(results.filter((result) => result.success).length, 1);
    const curator = new CuratorStore({ agentRoot: root });
    try {
      assert.equal(curator.list().filter((row) => row.state === "active").length, 1);
      const report = await inventorySkills({ roots: [{ scope: "global", path: path.join(root, "skills") }], curator });
      assert.equal(report.skills[0].generation, "verified");
      assert.equal(report.skills[0].cleanupEligible, false);
    } finally { curator.close(); }
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill();
    await Promise.allSettled(children.map((child) => child.done));
    await fs.rm(root, { recursive: true, force: true });
  }
});
