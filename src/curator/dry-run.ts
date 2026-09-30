import { inventorySkills } from "./inventory.js";
import { snapshotFingerprint } from "./files.js";
import { evaluateCuratorPolicy } from "./policy.js";
import type { PolicyReport, PolicySkill } from "./policy.js";
import type { CuratorRecord, InventoryRoot, ObservationSummary } from "./model.js";
import type { CuratorStore } from "./store.js";

export async function dryRunCurator(options: {
  roots: InventoryRoot[];
  curator: CuratorStore;
  policy?: unknown;
  now?: Date;
}): Promise<PolicyReport & { warnings: string[] }> {
  const inventory = await inventorySkills({ roots: options.roots, curator: options.curator });
  const warnings = [...inventory.warnings];
  let records: CuratorRecord[] = [];
  let observation: ObservationSummary | null = null;
  try {
    const snapshot = options.curator.readSnapshot();
    records = snapshot.records;
    observation = snapshot.observation;
  } catch {
    warnings.push("snapshot-unavailable");
  }
  const inUse = observation?.runs.some((run) => run.endedAt === null || run.state === "open") ?? true;
  const byGeneration = new Map(records.filter((record) => record.state === "active").map((record) => [record.generationId, record]));
  const skills: PolicySkill[] = inventory.skills.map((row) => {
    const record = row.generationId ? byGeneration.get(row.generationId) : undefined;
    const verified = Boolean(record && row.generation === "verified" && record.skillId === row.skillId
      && record.scope === row.scope && snapshotFingerprint(record) === row.verificationKey);
    return {
      skillId: row.skillId, generationId: verified ? record!.generationId : null,
      source: row.source, generationVerified: verified,
      createdAt: verified ? record!.createdAt : null, modifiedAt: verified ? record!.modifiedAt : null,
      adoptedAt: null, lastActivityAt: verified ? record!.lastActivityAt : null,
      pinned: false, inUse,
    };
  });
  return {
    ...evaluateCuratorPolicy({ skills, observation, policy: options.policy, now: options.now ?? new Date(),
      inventoryIncomplete: warnings.some((warning) => warning !== "observation-gap")
        || (inventory.partial && inventory.warnings.length === 0) }),
    warnings: [...new Set(warnings)],
  };
}
