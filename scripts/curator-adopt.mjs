#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { createJiti } from "jiti";

async function main() {
  const { values, positionals } = parseArgs({ options: {
    init: { type: "boolean" }, list: { type: "boolean" }, exclude: { type: "string" }, expect: { type: "string" },
  } });
  if (positionals.length || Number(values.init === true) + Number(values.list === true) !== 1
    || (values.init && (!values.exclude || !values.expect)) || (values.list && (values.exclude || values.expect))) {
    throw new Error("Usage: curator-adopt --init --exclude <skill-id> --expect <count> | --list");
  }
  const jiti = createJiti(import.meta.url, { fsCache: false, tryNative: false });
  const { resolveAgentRoot } = await jiti.import("../src/paths.ts");
  const { readRunnerConfig } = await jiti.import("../src/curator/runner.ts");
  const { parseSkillId } = await jiti.import("../src/store/skill-utils.ts");
  const { createAdoptionCohort, readAdoptionManifest } = await jiti.import("../src/curator/adoption-archive.ts");
  const root = resolveAgentRoot();
  if (values.list) {
    const manifest = await readAdoptionManifest(root);
    console.log(JSON.stringify(manifest ? { adoptedAt: manifest.adoptedAt, total: manifest.skills.length,
      active: manifest.skills.filter((row) => row.state === "active").length,
      archived: manifest.skills.filter((row) => row.state === "archived")
        .map((row) => ({ skillId: row.skillId, path: row.archivePath })) } : { total: 0, active: 0, archived: [] }, null, 2));
    return;
  }
  const expected = Number(values.expect);
  if (!Number.isSafeInteger(expected) || expected < 1 || !parseSkillId(values.exclude)) throw new Error("invalid-adoption-selection");
  const config = readRunnerConfig(root);
  if (!config?.enabled || config.paused !== true) throw new Error("adoption-requires-paused-curator");
  const file = path.join(root, "pi-hermes-memory", "curator", "usage-cohort.json");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("unsafe-usage-cohort");
  let cohort;
  try { cohort = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("invalid-usage-cohort"); }
  if (!Array.isArray(cohort.skills) || !cohort.skills.some((row) => row.id === values.exclude)) throw new Error("protected-skill-not-in-cohort");
  const selected = cohort.skills.filter((row) => row.id !== values.exclude);
  if (selected.length !== expected) throw new Error("adoption-count-mismatch");
  const roots = [{ scope: "global", path: config.globalRoot }];
  const names = new Set();
  for (const row of selected) {
    const parsed = parseSkillId(row.id);
    if (!parsed || (parsed.scope === "project" && (!parsed.projectName ||
      (config.scopeKeys && !config.scopeKeys.has(parsed.projectName))))) throw new Error("invalid-scope-selection");
    if (parsed.scope === "project") names.add(parsed.projectName);
  }
  for (const name of names) roots.push({ scope: "project", projectName: name,
    path: path.join(config.projectsRoot, name, "skills") });
  for (const row of selected) {
    const parsed = parseSkillId(row.id);
    const parent = parsed.scope === "global" ? config.globalRoot : path.join(config.projectsRoot, parsed.projectName, "skills");
    if (path.resolve(row.path) !== path.join(parent, parsed.slug, "SKILL.md")) throw new Error("cohort-path-changed");
  }
  const manifest = await createAdoptionCohort({ agentRoot: root, roots, skillIds: selected.map((row) => row.id), now: new Date() });
  console.log(JSON.stringify({ source: manifest.source, adoptedAt: manifest.adoptedAt, count: manifest.skills.length,
    protected: values.exclude, archiveEnabled: false }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
