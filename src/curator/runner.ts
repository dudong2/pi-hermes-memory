import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_PROJECTS_MEMORY_DIR } from "../constants.js";
import { expandHome } from "../paths.js";
import { parseSkillId } from "../store/skill-utils.js";
import type { InventoryRoot } from "./model.js";
import { normalizeCuratorPolicy, type CuratorPolicyConfig } from "./policy.js";
import { removeUnusedSkills, type RemovalResult } from "./removal.js";
import { CuratorStore } from "./store.js";
import { ProjectScopeBinding } from "../scope/project-binding.js";

interface RunnerConfig {
  enabled: boolean;
  paused: boolean;
  policy: CuratorPolicyConfig;
  globalRoot: string;
  projectsRoot: string;
  resolutionMode: "cwd" | "catalog";
  scopeCatalogDir?: string;
  scopeKeys?: ReadonlySet<string>;
}

function directorySegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/\u0000:]/.test(value);
}

// Only the fields granting removal authority are read here. Invalid/missing
// configuration never falls back to settings that could authorize deletion.
export function readRunnerConfig(agentRoot: string): RunnerConfig | null {
  try {
    const configPath = path.join(agentRoot, "hermes-memory-config.json");
    if (fs.statSync(configPath).size > 1024 * 1024) return null;
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if ((raw.curatorEnabled !== undefined && typeof raw.curatorEnabled !== "boolean")
      || (raw.curatorPaused !== undefined && typeof raw.curatorPaused !== "boolean")) return null;
    const policy = normalizeCuratorPolicy(raw.curatorPolicy);
    if (!policy) return null;
    let memoryRoot = path.join(agentRoot, "pi-hermes-memory");
    if (raw.memoryDir !== undefined) {
      if (typeof raw.memoryDir !== "string") return null;
      const configured = raw.memoryDir.trim();
      if (configured) {
        memoryRoot = path.resolve(agentRoot, expandHome(configured));
        if (memoryRoot === path.join(agentRoot, "memory")) memoryRoot = path.join(agentRoot, "pi-hermes-memory");
      }
    }
    let projectsDir = raw.projectsMemoryDir ?? DEFAULT_PROJECTS_MEMORY_DIR;
    if (typeof projectsDir !== "string") return null;
    projectsDir = expandHome(projectsDir.trim());
    if (path.isAbsolute(projectsDir)) projectsDir = path.relative(agentRoot, projectsDir);
    if (!directorySegment(projectsDir)) return null;
    const resolutionMode = raw.projectResolutionMode ?? "cwd";
    if (resolutionMode !== "cwd" && resolutionMode !== "catalog") return null;
    let scopeCatalogDir: string | undefined;
    let scopeKeys: ReadonlySet<string> | undefined;
    if (resolutionMode === "catalog") {
      if (typeof raw.scopeCatalogDir !== "string" || !raw.scopeCatalogDir.trim()) return null;
      scopeCatalogDir = path.resolve(agentRoot, expandHome(raw.scopeCatalogDir.trim()));
      const binding = new ProjectScopeBinding({ projectResolutionMode: "catalog", scopeCatalogDir });
      if (!binding.available) return null;
      scopeKeys = binding.keys();
    }
    return { enabled: raw.curatorEnabled !== false, paused: raw.curatorPaused === true, policy,
      globalRoot: path.join(memoryRoot, "skills"), projectsRoot: path.join(agentRoot, projectsDir),
      resolutionMode, scopeCatalogDir, scopeKeys };
  } catch { return null; }
}

function configuredRoots(config: RunnerConfig, curator: CuratorStore): InventoryRoot[] {
  const roots: InventoryRoot[] = [{ scope: "global", path: config.globalRoot }];
  const names = new Set<string>();
  for (const record of curator.list()) {
    const parsed = parseSkillId(record.skillId);
    if (parsed?.scope !== "project" || !parsed.projectName || !directorySegment(parsed.projectName)
      || (config.scopeKeys && !config.scopeKeys.has(parsed.projectName))) continue;
    names.add(parsed.projectName);
  }
  for (const projectName of names) roots.push({ scope: "project", projectName,
    path: path.join(config.projectsRoot, projectName, "skills") });
  return roots;
}

export async function runCuratorCycle(options: { agentRoot: string; signal?: AbortSignal; now?: Date }): Promise<RemovalResult> {
  const empty = { removed: 0, held: 0, failed: 0 };
  const root = path.resolve(options.agentRoot);
  const config = readRunnerConfig(root);
  if (!config || !config.enabled || config.paused || options.signal?.aborted) return empty;
  const curator = new CuratorStore({ agentRoot: root });
  const currentPolicy = () => {
    const current = readRunnerConfig(root);
    if (!current?.enabled || current.paused || options.signal?.aborted
      || current.globalRoot !== config.globalRoot || current.projectsRoot !== config.projectsRoot
      || current.resolutionMode !== config.resolutionMode || current.scopeCatalogDir !== config.scopeCatalogDir
      || JSON.stringify([...(current.scopeKeys ?? [])].sort((a, b) => a.localeCompare(b))) !== JSON.stringify([...(config.scopeKeys ?? [])].sort((a, b) => a.localeCompare(b)))) return null;
    return current.policy;
  };
  try {
    if (!curator.list().length) return empty;
    const roots = configuredRoots(config, curator);
    await curator.withMutation(roots.map((entry) => entry.path), async () => {
      if (currentPolicy()) curator.reconcileExitedProcesses();
    });
    return await removeUnusedSkills({ curator, roots, policy: currentPolicy, now: options.now });
  } catch { return { ...empty, failed: 1 }; }
  finally { curator.close(); }
}

export function validateInterval(intervalMs: number): void {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2 ** 31 - 1) {
    throw new Error("invalid-curator-interval");
  }
}

export async function runPeriodicCurator(options: {
  intervalMs: number;
  signal: AbortSignal;
  cycle: () => Promise<unknown>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  validateInterval(options.intervalMs);
  const wait = options.wait ?? (async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); });
  // Serial cycles, no missed-tick catch-up and no per-target logs or notices.
  while (!options.signal.aborted) {
    try { await options.cycle(); } catch { /* Retry at the next configured interval, without granting new authority. */ }
    if (options.signal.aborted) break;
    try { await wait(options.intervalMs, options.signal); } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}
