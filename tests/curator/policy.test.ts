import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { evaluateCuratorPolicy, normalizeCuratorPolicy } from "../../src/curator/policy.js";
import type { CuratorPolicyConfig, PolicySkill } from "../../src/curator/policy.js";
import { SUPPORTED_ACTIVITY_PATHS } from "../../src/curator/model.js";
import type { ObservationRun, ObservationSummary } from "../../src/curator/model.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-15T00:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const CONFIG: CuratorPolicyConfig = {
  inactivityDays: 10, minimumObservationDays: 14, creationGraceDays: 7,
  modificationGraceDays: 3, adoptionGraceDays: 5, maxObservationAgeDays: 2,
};
const SKILL: PolicySkill = {
  skillId: "global:policy-fixture", generationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  source: "creation-boundary", generationVerified: true, createdAt: ago(100), modifiedAt: ago(60),
  adoptedAt: null, lastActivityAt: ago(35), pinned: false, inUse: false,
};
function run(start = 40, end = 0, state: ObservationRun["state"] = "closed", id = "run-1"): ObservationRun {
  return { runId: id, sessionKey: "temporary-session-hash", startedAt: ago(start), endedAt: state === "open" ? null : ago(end), state, producerVersion: "pi-hooks-v1" };
}
function observation(runs = [run()]): ObservationSummary {
  return { runs, gaps: [], supportedPaths: SUPPORTED_ACTIVITY_PATHS, allPathsObserved: false };
}
function evaluate(skill: Partial<PolicySkill> = {}, obs = observation(), ...configured: unknown[]) {
  const policy = configured.length === 0 ? CONFIG : configured[0];
  return evaluateCuratorPolicy({ skills: [{ ...SKILL, ...skill }], observation: obs, policy, now: NOW });
}

describe("Curator deterministic dry-run policy", () => {
  it("never treats an unset or invalid policy as permission", () => {
    assert.equal(evaluate({}, observation(), undefined).candidateCount, 0);
    assert.ok(evaluateCuratorPolicy({ skills: [SKILL], observation: observation(), now: NOW }).decisions[0].reasons.includes("policy-not-configured"));
    assert.equal(normalizeCuratorPolicy({ ...CONFIG, inactivityDays: -1 }), null);
    assert.equal(normalizeCuratorPolicy({ ...CONFIG, inactivityDays: 0 }), null);
    assert.equal(normalizeCuratorPolicy({ ...CONFIG, minimumObservationDays: Infinity }), null);
    assert.equal(normalizeCuratorPolicy({ ...CONFIG, creationGraceDays: "7" }), null);
    assert.equal(normalizeCuratorPolicy({ inactivityDays: 10 }), null);
    assert.equal(normalizeCuratorPolicy({ ...CONFIG, pinnedSkillIds: ["not-a-skill-id"] }), null);
    assert.equal(normalizeCuratorPolicy({ ...CONFIG, automaticArchiving: true }), null);
    assert.deepEqual(normalizeCuratorPolicy(CONFIG), CONFIG);
  });

  it("reports a candidate only within proven closed continuous observation, never cleanup eligibility", () => {
    const result = evaluate();
    assert.equal(result.candidateCount, 1);
    assert.equal(result.decisions[0].candidate, true);
    assert.equal(result.decisions[0].cleanupEligible, false);
    assert.equal(result.automaticArchiving, false);
    assert.equal(result.evidenceScope, "continuous-closed-supported-paths");
    assert.equal(result.decisions[0].boundaries.observedInactivityDays, 35);
  });

  it("requires observation rather than treating null activity as unused", () => {
    assert.equal(evaluate({ lastActivityAt: null }, observation([])).candidateCount, 0);
    assert.equal(evaluate({ lastActivityAt: null }).candidateCount, 1);
    assert.equal(evaluate({ lastActivityAt: null, createdAt: ago(1), modifiedAt: ago(1) }).candidateCount, 0);
  });

  it("checks inactivity exactly at the configured boundary", () => {
    assert.equal(evaluate({ lastActivityAt: ago(10) }).candidateCount, 1);
    assert.equal(evaluate({ lastActivityAt: new Date(NOW.getTime() - 10 * DAY + 1).toISOString() }).candidateCount, 0);
    assert.ok(evaluate({ lastActivityAt: ago(9) }).decisions[0].reasons.includes("recent-activity"));
  });

  it("protects pinned, in-use, unknown-provenance, and uncertain generations", () => {
    for (const [override, reason] of [
      [{ pinned: true }, "pinned"], [{ inUse: true }, "in-use"],
      [{ source: "creation-history-matched" }, "unknown-provenance"],
      [{ generationVerified: false }, "unverified-generation"], [{ generationId: null }, "unverified-generation"],
    ] as const) {
      const result = evaluate(override);
      assert.equal(result.candidateCount, 0);
      assert.ok(result.decisions[0].reasons.includes(reason));
    }
    assert.equal(evaluate({}, observation(), { ...CONFIG, pinnedSkillIds: [SKILL.skillId] }).candidateCount, 0);
  });

  it("applies creation, modification, and initial-adoption grace independently", () => {
    assert.ok(evaluate({ createdAt: ago(1), modifiedAt: ago(1), lastActivityAt: null }).decisions[0].reasons.includes("creation-grace"));
    assert.ok(evaluate({ modifiedAt: ago(1) }).decisions[0].reasons.includes("modification-grace"));
    assert.ok(evaluate({ adoptedAt: ago(1) }).decisions[0].reasons.includes("adoption-grace"));
    assert.equal(evaluate({ modifiedAt: ago(3) }).decisions[0].reasons.includes("modification-grace"), false);
    assert.equal(evaluate({ adoptedAt: ago(5) }).decisions[0].reasons.includes("adoption-grace"), false);
  });

  it("merges overlap without double-counting and resets across uncovered gaps", () => {
    const overlap = evaluate({}, observation([run(30, 10), run(20, 0, "closed", "run-2")]), { ...CONFIG, minimumObservationDays: 35 });
    assert.equal(overlap.candidateCount, 0);
    assert.equal(overlap.decisions[0].boundaries.observedDays, 30);
    const gap = evaluate({}, observation([run(40, 2), run(1, 0, "closed", "run-2")]));
    assert.equal(gap.candidateCount, 0);
    assert.equal(gap.decisions[0].boundaries.observationStartAt, ago(1));
  });

  it("does not trust open, faulted, or unsupported observer runs", () => {
    assert.ok(evaluate({}, observation([run(), run(1, 0, "open", "active")])).decisions[0].reasons.includes("observation-open"));
    assert.ok(evaluate({}, observation([run(), run(5, 4, "faulted", "fault")])).decisions[0].reasons.includes("observation-fault"));
    const unsupported = { ...run(), producerVersion: "unknown-observer" };
    assert.ok(evaluate({}, observation([unsupported])).decisions[0].reasons.includes("unsupported-observer"));
  });

  it("excludes known gaps in the latest window but allows a later sufficient healthy window", () => {
    const obs = observation();
    obs.gaps.push({ runId: "run-1", generationId: SKILL.generationId, at: ago(5), reason: "observer-error" });
    assert.equal(evaluate({}, obs).candidateCount, 0);
    const fresh = observation([run(16), run(30, 18, "faulted", "old-fault")]);
    fresh.gaps.push({ runId: "old-fault", generationId: null, at: ago(20), reason: "observer-error" });
    assert.equal(evaluate({}, fresh).candidateCount, 1);
  });

  it("does not count an unobserved tail and reports observation freshness", () => {
    const fresh = evaluate({}, observation([run(40, 2)]));
    assert.equal(fresh.candidateCount, 1);
    assert.equal(fresh.decisions[0].boundaries.observationAsOfAt, ago(2));
    assert.equal(fresh.decisions[0].boundaries.observedInactivityDays, 33);
    assert.ok(evaluate({}, observation([run(40, 3)])).decisions[0].reasons.includes("stale-observation"));
    assert.equal(evaluate({ lastActivityAt: ago(1) }, observation([run(40, 2)])).candidateCount, 0);
  });

  it("fails closed on invalid dates, reversed windows, future events, or incomplete inventory", () => {
    assert.ok(evaluate({ createdAt: "bad date" }).decisions[0].reasons.includes("invalid-time"));
    assert.equal(evaluate({ lastActivityAt: ago(-1) }).candidateCount, 0);
    assert.equal(evaluate({}, observation([run(1, 2)])).candidateCount, 0);
    assert.equal(evaluate({}, observation([run(40, -1)])).candidateCount, 0);
    const incomplete = evaluateCuratorPolicy({ skills: [SKILL], observation: observation(), policy: CONFIG, now: NOW, inventoryIncomplete: true });
    assert.ok(incomplete.decisions[0].reasons.includes("inventory-incomplete"));
    assert.equal(evaluateCuratorPolicy({ skills: [SKILL], observation: observation(), policy: CONFIG, now: new Date(NaN) }).candidateCount, 0);
  });

  it("does not mutate policy inputs", () => {
    const input = { skills: [SKILL], observation: observation(), policy: CONFIG, now: NOW };
    const before = JSON.stringify(input);
    evaluateCuratorPolicy(input);
    assert.equal(JSON.stringify(input), before);
  });
});
