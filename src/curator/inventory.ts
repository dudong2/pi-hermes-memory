import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildSkillId, parseFrontmatter, slugify } from "../store/skill-utils.js";
import { MAX_SKILL_BYTES, readLimited, sameSnapshot, snapshotSkill, snapshotFingerprint, pathKey } from "./files.js";
import { readCreationHistory } from "./history.js";
import type { CuratorStore } from "./store.js";
import type { CreationEvidence, CuratorRecord, InventoryReport, InventoryRoot } from "./model.js";

export async function inventorySkills(options: {
  roots: InventoryRoot[];
  curator: CuratorStore;
  historyFiles?: string[];
}): Promise<InventoryReport> {
  const report: InventoryReport = { skills: [], warnings: options.curator.getWarnings(), partial: false };
  let records: CuratorRecord[] = [];
  try {
    records = options.curator.list();
  } catch {
    report.warnings.push("ledger-unavailable");
    report.partial = true;
  }
  const history = await readCreationHistory(options.historyFiles ?? []);
  report.warnings.push(...history.warnings);
  report.partial ||= history.partial;
  const active = new Map(records.filter((row) => row.state === "active")
    .map((row) => [`${row.rootKey}:${row.relativePath}`, row]));
  const seen = new Set<string>();
  for (const root of options.roots) {
    const entries: import("node:fs").Dirent[] = [];
    try {
      if ((await fs.lstat(root.path)).isSymbolicLink()) throw new Error("unsafe-root");
      const directory = await fs.opendir(root.path);
      for await (const entry of directory) {
        entries.push(entry);
        if (entries.length > 5000) break;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        report.warnings.push("root-unavailable");
        report.partial = true;
      }
      continue;
    }
    if (entries.length > 5000) {
      report.warnings.push("inventory-limit");
      report.partial = true;
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) {
        report.warnings.push("symlink-skipped");
        report.partial = true;
        continue;
      }
      const filePath = entry.isDirectory()
        ? path.join(root.path, entry.name, "SKILL.md")
        : entry.isFile() && entry.name.endsWith(".md") ? path.join(root.path, entry.name) : null;
      if (!filePath) continue;
      if (seen.has(path.resolve(filePath))) continue;
      seen.add(path.resolve(filePath));
      try {
        const text = (await readLimited(filePath, MAX_SKILL_BYTES)).toString("utf8");
        const meta = parseFrontmatter(text).meta;
        const name = slugify(meta.name ?? "");
        if (!name || !meta.description) throw new Error("invalid-skill-metadata");
        const skillId = buildSkillId(root.scope, name, root.projectName ?? null);
        const snapshot = await snapshotSkill({
          agentRoot: options.curator.agentRoot, root: root.path, filePath, skillId, scope: root.scope,
        });
        const record = active.get(`${snapshot.rootKey}:${snapshot.relativePath}`);
        const verified = Boolean(record && sameSnapshot(record, snapshot))
          && report.warnings.every((warning) => !warning.startsWith("ledger-"));
        const matchedHistory = history.creations.some((event: CreationEvidence) => event.pathKey === pathKey(filePath)
          && event.skillId === skillId && event.scope === root.scope && event.createdDate === meta.created);
        report.skills.push({
          skillId, scope: root.scope, relativePath: snapshot.relativePath,
          source: verified ? "creation-boundary" : matchedHistory ? "creation-history-matched" : "unknown",
          generation: verified ? "verified" : "unverified",
          generationId: verified ? record!.generationId : null,
          verificationKey: verified ? snapshotFingerprint(snapshot) : null, cleanupEligible: false,
          lastActivityAt: verified ? record!.lastActivityAt : null,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          report.warnings.push("skill-unavailable");
          report.partial = true;
        }
      }
    }
  }
  try {
    report.observation = options.curator.observations();
    if (report.observation.gaps.length || report.observation.runs.some((run) => run.state === "faulted")) {
      report.warnings.push("observation-gap");
    }
  } catch {
    report.warnings.push("observation-unavailable");
  }
  report.warnings = [...new Set(report.warnings)];
  report.partial ||= report.warnings.length > 0;
  return report;
}
