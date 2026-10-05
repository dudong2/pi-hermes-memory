import * as path from "node:path";
import { parseSkillId } from "../store/skill-utils.js";
import { CuratorStore } from "./store.js";
import { loadAdoptedUsage, readAdoptionManifest, runAdoptedArchiveCycle, type ArchiveCycleResult, type UsageEvidence } from "./adoption-archive.js";
import { readRunnerConfig } from "./runner.js";
import type { InventoryRoot } from "./model.js";

export async function runAdoptedStartupCycle(options: {
  agentRoot: string; now?: Date; usage?: () => Promise<UsageEvidence>; dryRunOnly?: boolean;
}): Promise<ArchiveCycleResult> {
  const empty: ArchiveCycleResult = { archived: 0, held: 0, failed: 0, eligible: 0 };
  const root = path.resolve(options.agentRoot);
  const config = readRunnerConfig(root);
  if (!config?.enabled) return empty;
  let curator: CuratorStore | undefined;
  try {
    const manifest = await readAdoptionManifest(root);
    if (!manifest) return empty;
    const names = new Set<string>();
    for (const row of manifest.skills) {
      const parsed = parseSkillId(row.skillId);
      if (!parsed || (parsed.scope === "project" && (!parsed.projectName ||
        (config.scopeKeys && !config.scopeKeys.has(parsed.projectName))))) return { ...empty, failed: 1 };
      if (parsed.scope === "project") names.add(parsed.projectName!);
    }
    const roots: InventoryRoot[] = [{ scope: "global", path: config.globalRoot }];
    for (const name of names) roots.push({ scope: "project", projectName: name,
      path: path.join(config.projectsRoot, name, "skills") });
    const currentConfig = () => {
      const current = readRunnerConfig(root);
      if (!current?.enabled || current.globalRoot !== config.globalRoot || current.projectsRoot !== config.projectsRoot
        || [...names].some((name) => current.scopeKeys && !current.scopeKeys.has(name))) return null;
      return current;
    };
    curator = new CuratorStore({ agentRoot: root });
    return await runAdoptedArchiveCycle({ agentRoot: root, roots, now: options.now ?? new Date(), curator,
      policy: () => currentConfig()?.policy,
      paused: () => options.dryRunOnly === true || currentConfig()?.paused !== false,
      usage: options.usage ?? (() => loadAdoptedUsage(root, manifest)) });
  } catch { return { ...empty, failed: 1 }; }
  finally { curator?.close(); }
}
