import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AGENT_ROOT } from "./paths.js";

const DEFAULT_FAILURE_LOG = path.join(AGENT_ROOT, "pi-hermes-memory", "consolidation-failures.jsonl");

function safeFailureReason(reason: string | undefined): string {
  const timeout = reason?.match(/(?:^|; )Consolidation subprocess timed out after (\d{1,9})ms\./);
  if (timeout) return `Consolidation subprocess timed out after ${timeout[1]}ms.`;
  if (/(?:^|; )Consolidation subprocess was cancelled\./.test(reason ?? "")) {
    return "Consolidation subprocess was cancelled.";
  }
  if (/(?:^|; )Consolidation subprocess was terminated by Pi \(timeout or cancellation not confirmed\)\./.test(reason ?? "")) {
    return "Consolidation subprocess was terminated by Pi (timeout or cancellation not confirmed).";
  }
  if (reason && (
    /^Consolidation process exited with code -?\d{1,4} \(child stderr omitted\)\.$/.test(reason)
    || /^Consolidation failed before completion \((?:[A-Za-z][A-Za-z0-9]{0,39}|unknown error); details omitted\)\.$/.test(reason)
  )) return reason;
  return "unclassified consolidation failure";
}

export async function appendAutoConsolidationFailureLog(
  target: "memory" | "user" | "failure" | "project",
  sessionScope: string | null,
  reason: string | undefined,
  logPath = DEFAULT_FAILURE_LOG,
): Promise<void> {
  const record = {
    timestamp: new Date().toISOString(),
    target,
    sessionScope: sessionScope?.slice(0, 128) || null,
    reason: safeFailureReason(reason),
  };
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function formatAutoConsolidationFailure(
  target: "memory" | "user" | "failure" | "project",
  sessionScope: string | null,
  reason: string | undefined,
): string {
  return `⚠️ Auto-consolidation failed target=${JSON.stringify(target)}`
    + ` sessionScope=${JSON.stringify(sessionScope || null)}`
    + ` reason=${JSON.stringify(reason ?? "no reason reported")}`;
}

export function shouldWarnAutoConsolidationFailure(
  warnOnFailure: boolean,
  consolidated: boolean,
  partial = false,
): boolean {
  return warnOnFailure && (!consolidated || partial);
}
