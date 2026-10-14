import fs from "node:fs/promises";
import path from "node:path";

const FILE_NAME = "skill-candidate-decisions.jsonl";

export async function recordSkillCandidate(root: string, failedCriteria: number[]): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  // Keep only the decision, never the candidate's text, task, or user prompt.
  await fs.appendFile(path.join(root, FILE_NAME), JSON.stringify({
    at: new Date().toISOString(),
    failedCriteria,
  }) + "\n", { mode: 0o600 });
}

export async function skillCandidateInsights(root: string): Promise<{
  considered: number;
  rejected: number;
  approved: number;
  failedCriteria: Record<"1" | "2" | "3" | "4", number>;
}> {
  const stats = {
    considered: 0,
    rejected: 0,
    approved: 0,
    failedCriteria: { "1": 0, "2": 0, "3": 0, "4": 0 },
  };
  let data: string;
  try {
    data = await fs.readFile(path.join(root, FILE_NAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return stats;
    throw error;
  }
  for (const line of data.split("\n")) {
    if (!line) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || typeof entry !== "object" || !Array.isArray((entry as { failedCriteria?: unknown }).failedCriteria)) continue;
    const failures = (entry as { failedCriteria: unknown[] }).failedCriteria;
    if (failures.some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 4)) continue;
    stats.considered++;
    if (failures.length) stats.rejected++;
    else stats.approved++;
    for (const number of new Set(failures as number[])) {
      stats.failedCriteria[String(number) as "1" | "2" | "3" | "4"]++;
    }
  }
  return stats;
}
