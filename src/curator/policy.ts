import { parseSkillId } from "../store/skill-utils.js";
import { SUPPORTED_ACTIVITY_PATHS } from "./model.js";
import type { InventoryRow, ObservationSummary } from "./model.js";

export interface CuratorPolicyConfig {
  inactivityDays: number;
  minimumObservationDays: number;
  creationGraceDays: number;
  modificationGraceDays: number;
  adoptionGraceDays: number;
  maxObservationAgeDays: number;
  pinnedSkillIds?: string[];
}
export interface PolicySkill {
  skillId: string;
  generationId: string | null;
  source: InventoryRow["source"];
  generationVerified: boolean;
  createdAt: string | null;
  modifiedAt: string | null;
  adoptedAt?: string | null;
  lastActivityAt: string | null;
  pinned: boolean;
  inUse: boolean;
}
export type PolicyReason = "policy-not-configured" | "invalid-policy" | "invalid-time" | "unknown-provenance"
  | "unverified-generation" | "pinned" | "in-use" | "observation-missing" | "observation-fault"
  | "unsupported-observer" | "observation-open" | "stale-observation" | "insufficient-observation"
  | "creation-grace" | "modification-grace" | "adoption-grace" | "recent-activity" | "inventory-incomplete";
export interface PolicyDecision {
  skillId: string;
  generationId: string | null;
  candidate: boolean;
  cleanupEligible: false;
  reasons: PolicyReason[];
  boundaries: Record<string, string | number | null>;
}
export interface PolicyReport {
  stage: "C";
  dryRun: true;
  automaticArchiving: false;
  evaluatedAt: string | null;
  evidenceScope: "continuous-closed-supported-paths";
  policy: CuratorPolicyConfig | null;
  policyStatus: "configured" | "not-configured" | "invalid";
  decisions: PolicyDecision[];
  candidateCount: number;
  heldCount: number;
  limitations: string[];
}

const DAY = 86_400_000;
const DURATION_KEYS = ["inactivityDays", "minimumObservationDays", "creationGraceDays", "modificationGraceDays", "adoptionGraceDays", "maxObservationAgeDays"] as const;
function duration(value: unknown, positive = false): number | null {
  return typeof value === "number" && Number.isFinite(value) && (positive ? value > 0 : value >= 0)
    && Number.isSafeInteger(value * DAY) && value * DAY <= 8_000_000_000_000_000 ? value : null;
}

// No deployment defaults: an omitted, partial, or malformed policy holds every item.
export function normalizeCuratorPolicy(value: unknown): CuratorPolicyConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => ![...DURATION_KEYS, "pinnedSkillIds"].includes(key))) return null;
  const inactivityDays = duration(raw.inactivityDays, true);
  const minimumObservationDays = duration(raw.minimumObservationDays, true);
  const creationGraceDays = duration(raw.creationGraceDays);
  const modificationGraceDays = duration(raw.modificationGraceDays);
  const adoptionGraceDays = duration(raw.adoptionGraceDays);
  const maxObservationAgeDays = duration(raw.maxObservationAgeDays);
  if (inactivityDays === null || minimumObservationDays === null || creationGraceDays === null
    || modificationGraceDays === null || adoptionGraceDays === null || maxObservationAgeDays === null) return null;
  let pinnedSkillIds: string[] | undefined;
  if (raw.pinnedSkillIds !== undefined) {
    if (!Array.isArray(raw.pinnedSkillIds) || raw.pinnedSkillIds.length > 2000
      || !raw.pinnedSkillIds.every((id) => typeof id === "string" && id.length <= 1024 && parseSkillId(id))) return null;
    pinnedSkillIds = [...new Set(raw.pinnedSkillIds as string[])];
  }
  return { inactivityDays, minimumObservationDays, creationGraceDays, modificationGraceDays,
    adoptionGraceDays, maxObservationAgeDays, ...(pinnedSkillIds ? { pinnedSkillIds } : {}) };
}

function time(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}
function iso(value: number): string | null {
  return Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000 ? new Date(value).toISOString() : null;
}
interface Window { start: number; end: number; }
interface Coverage {
  window: Window | null;
  invalid: boolean;
  open: boolean;
  faulty: Window[];
  unsupported: Window[];
}
function coverage(observation: ObservationSummary | null, now: number): Coverage {
  const result: Coverage = { window: null, invalid: false, open: false, faulty: [], unsupported: [] };
  const healthy: Window[] = [];
  if (!observation) return result;
  for (const run of observation.runs) {
    const start = time(run.startedAt);
    const end = run.endedAt === null ? null : time(run.endedAt);
    if (run.endedAt === null || run.state === "open") result.open = true;
    if (start === null || start > now || (run.endedAt !== null && (end === null || end < start || end > now))) {
      result.invalid = true;
      continue;
    }
    if (end === null) continue;
    const interval = { start, end };
    if (run.producerVersion !== "pi-hooks-v1") result.unsupported.push(interval);
    else if (run.state !== "closed") result.faulty.push(interval);
    else healthy.push(interval);
  }
  healthy.sort((a, b) => a.start - b.start || a.end - b.end);
  // A hole resets the evidence window. Neither offline time nor previous windows
  // are added to inactivity, even if the same file has no recorded reads.
  for (const interval of healthy) {
    if (!result.window || interval.start > result.window.end) result.window = { ...interval };
    else result.window.end = Math.max(result.window.end, interval.end);
  }
  return result;
}
function intersects(left: Window, right: Window): boolean {
  return left.start <= right.end && left.end >= right.start;
}

export function evaluateCuratorPolicy(options: {
  skills: readonly PolicySkill[];
  observation: ObservationSummary | null;
  policy?: unknown;
  now: Date;
  inventoryIncomplete?: boolean;
}): PolicyReport {
  const now = options.now.getTime();
  const policy = normalizeCuratorPolicy(options.policy);
  const observed = coverage(options.observation, now);
  const decisions = options.skills.map((skill): PolicyDecision => {
    const reasons = new Set<PolicyReason>();
    const boundaries: PolicyDecision["boundaries"] = {};
    if (!policy) reasons.add(options.policy === undefined ? "policy-not-configured" : "invalid-policy");
    if (!Number.isFinite(now) || observed.invalid) reasons.add("invalid-time");
    if (options.inventoryIncomplete) reasons.add("inventory-incomplete");
    if (skill.source !== "creation-boundary") reasons.add("unknown-provenance");
    if (skill.generationVerified !== true || !skill.generationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(skill.generationId)) reasons.add("unverified-generation");
    if (skill.pinned !== false || policy?.pinnedSkillIds?.includes(skill.skillId)) reasons.add("pinned");
    if (skill.inUse !== false) reasons.add("in-use");
    if (observed.open) reasons.add("observation-open");
    const created = time(skill.createdAt);
    const modified = time(skill.modifiedAt);
    const adopted = skill.adoptedAt == null ? null : time(skill.adoptedAt);
    const activity = skill.lastActivityAt === null ? null : time(skill.lastActivityAt);
    if (created === null || modified === null || modified < created
      || (skill.adoptedAt != null && (adopted === null || adopted < created))
      || (skill.lastActivityAt !== null && (activity === null || activity < created))
      || [created, modified, adopted, activity].some((value) => value !== null && value > now)) reasons.add("invalid-time");
    const window = observed.window;
    if (!window) reasons.add("observation-missing");
    if (options.observation && !SUPPORTED_ACTIVITY_PATHS.every((route) => options.observation!.supportedPaths.includes(route))) {
      reasons.add("unsupported-observer");
    }
    if (observed.unsupported.some((interval) => !window || intersects(interval, window))) reasons.add("unsupported-observer");
    if (observed.faulty.some((interval) => !window || intersects(interval, window))) reasons.add("observation-fault");
    for (const gap of options.observation?.gaps ?? []) {
      const at = time(gap.at);
      if (at === null || at > now) reasons.add("invalid-time");
      else if ((!gap.generationId || gap.generationId === skill.generationId) && (!window || at >= window.start)) reasons.add("observation-fault");
    }
    if (policy && created !== null && modified !== null) {
      const grace = [
        [created, policy.creationGraceDays, "creation-grace", "creationEligibleAt"],
        [modified, policy.modificationGraceDays, "modification-grace", "modificationEligibleAt"],
        [adopted, policy.adoptionGraceDays, "adoption-grace", "adoptionEligibleAt"],
      ] as const;
      for (const [stamp, days, reason, label] of grace) {
        const eligible = stamp === null ? null : stamp + days * DAY;
        boundaries[label] = eligible === null ? null : iso(eligible);
        if (eligible !== null && (!boundaries[label] || eligible > now)) reasons.add(reason);
      }
      if (window) {
        const start = Math.max(window.start, created, adopted ?? created);
        const inactivityStart = Math.max(start, modified, activity ?? created);
        const span = Math.max(0, window.end - start);
        const inactive = Math.max(0, window.end - inactivityStart);
        boundaries.observationStartAt = iso(start);
        boundaries.observationAsOfAt = iso(window.end);
        boundaries.observedDays = span / DAY;
        boundaries.observedInactivityDays = inactive / DAY;
        boundaries.minimumObservationEligibleAt = iso(start + policy.minimumObservationDays * DAY);
        boundaries.inactivityEligibleAt = iso(inactivityStart + policy.inactivityDays * DAY);
        boundaries.observationFreshUntil = iso(window.end + policy.maxObservationAgeDays * DAY);
        if (span < policy.minimumObservationDays * DAY) reasons.add("insufficient-observation");
        if (inactive < policy.inactivityDays * DAY) reasons.add("recent-activity");
        if (now - window.end > policy.maxObservationAgeDays * DAY) reasons.add("stale-observation");
      }
    }
    return { skillId: skill.skillId, generationId: skill.generationId, candidate: reasons.size === 0,
      cleanupEligible: false, reasons: [...reasons], boundaries };
  });
  const candidateCount = decisions.filter((decision) => decision.candidate).length;
  return {
    stage: "C", dryRun: true, automaticArchiving: false, evaluatedAt: iso(now),
    evidenceScope: "continuous-closed-supported-paths", policy,
    policyStatus: policy ? "configured" : options.policy === undefined ? "not-configured" : "invalid", decisions,
    candidateCount, heldCount: decisions.length - candidateCount,
    limitations: ["supported-paths-only", "unobserved-time-excluded", "preview-is-not-cleanup-permission", "removal-requires-fresh-generation-and-cache-revalidation"],
  };
}
