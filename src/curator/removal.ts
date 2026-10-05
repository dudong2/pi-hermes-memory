import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalStoragePath } from "../store/canonical-storage-path.js";
import { parseSkillId } from "../store/skill-utils.js";
import { dryRunCurator } from "./dry-run.js";
import { normalizeCuratorPolicy } from "./policy.js";
import type { CuratorPolicyConfig } from "./policy.js";
import { pathKey, sameSnapshot, snapshotSkill } from "./files.js";
import { prepareArchiveDestination } from "./archive-files.js";
import type { CuratorRecord, InventoryRoot } from "./model.js";
import type { CuratorStore } from "./store.js";

export interface RemovalOptions {
  curator: CuratorStore;
  roots: InventoryRoot[];
  policy?: unknown | (() => unknown);
  now?: Date;
  basis?: "continuous" | "calendar";
  allowCachedSessions?: boolean;
  dryRunOnly?: boolean;
}
export interface RemovalResult { removed: number; held: number; failed: number; eligible?: number; }
interface Target { directory: string; filePath: string; directoryIdentity: string; }
function policy(options: RemovalOptions): CuratorPolicyConfig | null | undefined {
  const raw = typeof options.policy === "function" ? options.policy() : options.policy;
  return raw === undefined ? undefined : normalizeCuratorPolicy(raw);
}
function directoryIdentity(stat: { ino: bigint; dev: bigint; ctimeNs: bigint }): string {
  return `${stat.dev}:${stat.ino}:${stat.ctimeNs}`;
}

async function findRoot(roots: InventoryRoot[], record: CuratorRecord): Promise<InventoryRoot | null> {
  for (const root of roots) {
    if (root.scope === record.scope && pathKey(await canonicalStoragePath(root.path)) === record.rootKey) return root;
  }
  return null;
}

async function inspectTarget(options: RemovalOptions, root: InventoryRoot, record: CuratorRecord): Promise<Target | null> {
  const parsed = parseSkillId(record.skillId);
  if (!parsed || record.relativePath !== path.join(parsed.slug, "SKILL.md")) return null;
  if ((await fs.lstat(root.path)).isSymbolicLink()) return null;
  const physicalRoot = await fs.realpath(root.path);
  const directory = path.join(physicalRoot, parsed.slug);
  const filePath = path.join(directory, "SKILL.md");
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) return null;
  const entries = await fs.readdir(directory);
  // B proves SKILL.md use, not auxiliary use. Protect scripts/assets and manually
  // added content rather than extending irreversible cleanup to unobserved data.
  if (entries.length !== 1 || entries[0] !== "SKILL.md") return null;
  const snapshot = await snapshotSkill({ agentRoot: options.curator.agentRoot, root: physicalRoot,
    filePath, skillId: record.skillId, scope: record.scope });
  if (!sameSnapshot(record, snapshot)) return null;
  const final = await fs.lstat(directory, { bigint: true });
  if (directoryIdentity(final) !== directoryIdentity(stat)) return null;
  return { directory, filePath, directoryIdentity: directoryIdentity(final) };
}

async function removeLocked(options: RemovalOptions, root: InventoryRoot, generationId: string): Promise<boolean> {
  const fresh = await dryRunCurator({ ...options, policy: policy(options) });
  if (!fresh.decisions.some((row) => row.generationId === generationId && row.candidate)
    || (!options.allowCachedSessions && options.curator.hasCachedSessions())) return false;
  const record = options.curator.list().find((row) => row.generationId === generationId && row.state === "active");
  if (!record) return false;
  const target = await inspectTarget(options, root, record);
  if (!target) return false;
  // The paused path checks the same policy, generation and file snapshot under
  // the same lock, but does not revoke authority or touch the skill file.
  if (options.dryRunOnly) return true;
  const destination = await prepareArchiveDestination({ agentRoot: options.curator.agentRoot,
    skillId: record.skillId, directory: target.directory });
  // Revoke stale authority before moving; a crash cannot later target a new
  // same-name generation. A failed move leaves the original directory intact.
  if (!options.curator.forgetGeneration(record)) return false;
  const finalTarget = await inspectTarget(options, root, record);
  if (!finalTarget || finalTarget.directoryIdentity !== target.directoryIdentity) return false;
  await fs.rename(target.directory, destination);
  return true;
}

async function removeGeneration(options: RemovalOptions, generationId: string): Promise<boolean> {
  const record = options.curator.list().find((row) => row.generationId === generationId && row.state === "active");
  if (!record) return false;
  const root = await findRoot(options.roots, record);
  if (!root) return false;
  return options.curator.withMutation([root.path], () => removeLocked(options, root, generationId));
}

// Aggregate return values only: no approvals or per-skill notification.
// The archived directory lives outside every discovered skill root.
export async function removeUnusedSkills(options: RemovalOptions): Promise<RemovalResult> {
  const result: RemovalResult = { removed: 0, held: 0, failed: 0 };
  if (options.dryRunOnly) result.eligible = 0;
  try {
    const plan = await dryRunCurator({ ...options, policy: policy(options) });
    for (const decision of plan.decisions) {
      if (!decision.candidate || !decision.generationId) { result.held++; continue; }
      try {
        if (await removeGeneration(options, decision.generationId)) {
          if (options.dryRunOnly) result.eligible = (result.eligible ?? 0) + 1;
          else result.removed++;
        } else result.held++;
      } catch { result.failed++; }
    }
  } catch { result.failed++; }
  return result;
}
