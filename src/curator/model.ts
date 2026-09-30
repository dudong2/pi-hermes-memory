import type { SkillScope } from "../types.js";

export interface SkillSnapshot {
  skillId: string;
  scope: SkillScope;
  rootKey: string;
  rootRelativePath: string;
  relativePath: string;
  generationId: string | null;
  contentHash: string;
  fileIdentity: string;
}

export interface SkillMutation {
  kind: "create" | "modify" | "move" | "delete";
  before: SkillSnapshot | null;
  after: SkillSnapshot | null;
}

export interface SkillMutationTracker {
  readonly agentRoot: string;
  withMutation<T>(roots: string[], operation: () => Promise<T>): Promise<T>;
  record(event: SkillMutation): Promise<void>;
  noteFailure(): void;
}

export interface CuratorRecord extends Omit<SkillSnapshot, "generationId"> {
  generationId: string;
  state: "active" | "deleted";
  createdAt: string;
  modifiedAt: string;
  lastActivityAt: string | null;
}

export interface InventoryRoot {
  scope: SkillScope;
  path: string;
  projectName?: string;
}

export interface InventoryRow {
  skillId: string;
  scope: SkillScope;
  relativePath: string;
  source: "creation-boundary" | "creation-history-matched" | "unknown";
  generation: "verified" | "unverified";
  generationId?: string | null;
  verificationKey?: string | null;
  cleanupEligible: false;
  lastActivityAt: string | null;
}

export interface InventoryReport {
  skills: InventoryRow[];
  warnings: string[];
  partial: boolean;
  observation?: ObservationSummary;
}

export type ActivityKind = "read" | "view" | "skill-command";
export const SUPPORTED_ACTIVITY_PATHS = ["read-tool", "specific-skill-view", "confirmed-skill-command", "store-mutation"] as const;
export const OBSERVATION_GAP_REASONS = [
  "observer-error", "generation-changed", "unpaired-tool-result", "ambiguous-tool-call",
  "unconfirmed-skill-command", "ambiguous-skill-command", "incomplete-nested-calls",
  "unobserved-nested-call", "pending-at-session-end", "queue-overflow", "clock-regression",
] as const;
export type ObservationGapReason = typeof OBSERVATION_GAP_REASONS[number];

export interface ObservationRun {
  runId: string;
  sessionKey: string;
  startedAt: string;
  endedAt: string | null;
  state: "open" | "closed" | "faulted";
  producerVersion: string;
  ownerPid?: number | null;
  ownerFingerprint?: string | null;
}
export interface ObservationGap {
  runId: string;
  generationId: string | null;
  reason: ObservationGapReason;
  at: string;
}
export interface ActivityRecord {
  eventKey: string;
  runId: string;
  generationId: string;
  kind: ActivityKind;
  at: string;
}
export interface ObservationSummary {
  runs: ObservationRun[];
  gaps: ObservationGap[];
  supportedPaths: typeof SUPPORTED_ACTIVITY_PATHS;
  allPathsObserved: false;
}

export interface CreationEvidence {
  createdDate: string;
  eventId: string;
  pathKey: string;
  skillId: string;
  scope: SkillScope;
}
