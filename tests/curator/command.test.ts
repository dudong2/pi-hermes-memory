import { after, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CuratorPolicyConfig } from "../../src/curator/policy.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-command-"));
const previousAgentRoot = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { registerCuratorCommand } = await import("../../src/curator/command.js");
const { CuratorStore } = await import("../../src/curator/store.js");
const { SkillStore } = await import("../../src/store/skill-store.js");
const { loadConfig } = await import("../../src/config.js");
const curators: InstanceType<typeof CuratorStore>[] = [];
after(async () => {
  for (const curator of curators) curator.close();
  if (previousAgentRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentRoot;
  await fs.rm(root, { recursive: true, force: true });
});

function command(curator: InstanceType<typeof CuratorStore> | null, policy?: CuratorPolicyConfig | null) {
  let definition: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const messages: string[] = [];
  const notifications: string[] = [];
  const pi = {
    registerCommand(name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) {
      assert.equal(name, "memory-curator");
      definition = value;
    },
    sendMessage(message: { content: string }, options: { triggerTurn: boolean }) {
      assert.equal(options.triggerTurn, false);
      messages.push(message.content);
    },
  } as unknown as ExtensionAPI;
  const skills = new SkillStore({ globalSkillsDir: path.join(root, "global", "skills") });
  registerCuratorCommand(pi, curator, skills, undefined, policy);
  const ctx = (cwd = root, hasUI = false) => ({
    cwd, hasUI, ui: { notify: (text: string) => notifications.push(text) },
  }) as unknown as ExtensionCommandContext;
  return { definition: definition!, messages, notifications, ctx, skills };
}

describe("Curator command and configuration", () => {
  it("defaults to provenance recording and allows explicit disable", async () => {
    const file = path.join(root, "config.json");
    assert.equal(loadConfig(file).curatorEnabled, true);
    await fs.writeFile(file, JSON.stringify({ curatorEnabled: false }));
    assert.equal(loadConfig(file).curatorEnabled, false);
    await fs.writeFile(file, JSON.stringify({ curatorEnabled: "false" }));
    assert.equal(loadConfig(file).curatorEnabled, false);
  });

  it("reports disabled state without creating files", async () => {
    const c = command(null);
    await c.definition.handler("status", c.ctx());
    assert.match(c.messages[0], /curatorEnabled: false/);
    await assert.rejects(fs.stat(path.join(root, "pi-hermes-memory", "curator")), { code: "ENOENT" });
  });

  it("exposes a read-only inventory in headless and interactive modes", async () => {
    const curator = new CuratorStore({ agentRoot: root });
    curators.push(curator);
    const c = command(curator);
    await c.definition.handler("inventory", c.ctx());
    const report = JSON.parse(c.messages[0]);
    assert.equal(report.stage, "E");
    assert.equal(report.observation.allPathsObserved, false);
    assert.equal(report.automaticArchiving, false);
    assert.deepEqual(report.skills, []);
    await c.definition.handler("status", c.ctx(root, true));
    assert.equal(JSON.parse(c.notifications[0]).automaticArchiving, false);
    await assert.rejects(fs.stat(curator.dbPath), { code: "ENOENT" });
  });

  it("requires explicit complete duration settings without introducing defaults", async () => {
    const file = path.join(root, "policy-config.json");
    assert.equal(loadConfig(file).curatorPolicy, undefined);
    const policy = { inactivityDays: 10, minimumObservationDays: 14, creationGraceDays: 7, modificationGraceDays: 3, adoptionGraceDays: 5, maxObservationAgeDays: 2 };
    await fs.writeFile(file, JSON.stringify({ curatorPolicy: policy }));
    assert.deepEqual(loadConfig(file).curatorPolicy, policy);
    await fs.writeFile(file, JSON.stringify({ curatorPolicy: { ...policy, inactivityDays: -1 } }));
    assert.equal(loadConfig(file).curatorPolicy, null);
    await fs.writeFile(file, JSON.stringify({ curatorPolicy: { inactivityDays: 10 } }));
    assert.equal(loadConfig(file).curatorPolicy, null);
  });

  it("exposes dry-run without creating a ledger or modifying the skill root", async () => {
    const curator = new CuratorStore({ agentRoot: root });
    curators.push(curator);
    const c = command(curator);
    await c.definition.handler("dry-run", c.ctx());
    const result = JSON.parse(c.messages[0]);
    assert.equal(result.stage, "C");
    assert.equal(result.dryRun, true);
    assert.equal(result.automaticArchiving, false);
    assert.equal(result.candidateCount, 0);
    await assert.rejects(fs.stat(curator.dbPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(root, "global", "skills")), { code: "ENOENT" });
  });

  it("does not prompt or notify on conditional removal", async () => {
    const curator = new CuratorStore({ agentRoot: root });
    curators.push(curator);
    const c = command(curator);
    await c.definition.handler("remove", c.ctx());
    await c.definition.handler("remove", c.ctx(root, true));
    assert.deepEqual(c.messages, []);
    assert.deepEqual(c.notifications, []);
    await assert.rejects(fs.stat(curator.dbPath), { code: "ENOENT" });
  });

  it("rejects archive and restore subcommands", async () => {
    const c = command(null);
    await c.definition.handler("archive", c.ctx());
    assert.match(c.messages[0], /보관·복원은 지원하지 않습니다/);
  });
});
