import * as path from "node:path";
import { parseSkillId, slugify } from "../store/skill-utils.js";
import { pathKey, readLimited } from "./files.js";
import type { CreationEvidence } from "./model.js";

interface JsonObject { [key: string]: unknown; }
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

interface PendingCreate {
  eventId: string;
  name: string;
  scope: "global" | "project";
  createdDate: string;
}

export interface HistoryReport {
  creations: CreationEvidence[];
  unresolvedNestedCreations: number;
  warnings: string[];
  partial: boolean;
}

// This is provenance assistance, not a replay engine or a grant of management rights.
export async function readCreationHistory(files: string[]): Promise<HistoryReport> {
  const report: HistoryReport = { creations: [], unresolvedNestedCreations: 0, warnings: [], partial: false };
  const seenEvents = new Map<string, string>();
  const seenNested = new Set<string>();
  const uniqueFiles = [...new Set(files.map((file) => path.resolve(file)))];
  if (uniqueFiles.length > 100) report.warnings.push("history-file-limit");
  for (const file of uniqueFiles.slice(0, 100)) {
    try {
      const bytes = await readLimited(file, 8 * 1024 * 1024);
      const lines = bytes.toString("utf8").split("\n");
      let headerSeen = false;
      const pending = new Map<string, PendingCreate>();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 256 * 1024) {
          report.warnings.push("history-line-limit");
          continue;
        }
        let entry: JsonObject | null;
        try { entry = object(JSON.parse(line)); } catch {
          report.warnings.push("history-malformed-line");
          continue;
        }
        if (!entry) continue;
        if (!headerSeen) {
          if (entry.type !== "session" || entry.version !== 3 || typeof entry.id !== "string") {
            report.warnings.push("history-unsupported-header");
            break;
          }
          headerSeen = true;
          continue;
        }
        if (entry.type !== "message" || typeof entry.id !== "string") continue;
        const message = object(entry.message);
        if (!message) continue;
        const nested = object(message.nestedCalls);
        if (nested && Array.isArray(nested.calls)) {
          if (nested.complete === false) report.warnings.push("history-incomplete-nested-calls");
          for (const rawCall of nested.calls) {
            const call = object(rawCall);
            const args = object(call?.arguments);
            if (call?.name !== "skill_manage" || args?.action !== "create") continue;
            const key = `${entry.id}:${String(call.toolCallId ?? call.id ?? "")}`;
            if (!seenNested.has(key)) {
              seenNested.add(key);
              report.unresolvedNestedCreations++;
              report.warnings.push("history-nested-provenance-unavailable");
            }
          }
        }
        if (message.role === "assistant" && Array.isArray(message.content)) {
          for (const block of message.content) {
            const call = object(block);
            const args = object(call?.arguments);
            if (call?.type !== "toolCall" || call.name !== "skill_manage" || typeof call.id !== "string"
              || args?.action !== "create" || typeof args.name !== "string"
              || (args.scope !== "global" && args.scope !== "project")) continue;
            const timestamp = entry.timestamp;
            if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) {
              report.warnings.push("history-missing-timestamp");
              continue;
            }
            const candidate: PendingCreate = {
              eventId: `${entry.id}:${call.id}`, name: slugify(args.name), scope: args.scope,
              createdDate: timestamp.slice(0, 10),
            };
            if (pending.has(call.id)) {
              pending.delete(call.id);
              report.warnings.push("history-ambiguous-call");
            } else {
              pending.set(call.id, candidate);
            }
          }
        }
        if (message.role !== "toolResult" || message.toolName !== "skill_manage"
          || typeof message.toolCallId !== "string") continue;
        const request = pending.get(message.toolCallId);
        pending.delete(message.toolCallId);
        if (!request || message.isError === true || !Array.isArray(message.content)) continue;
        const textBlocks = message.content.map(object).filter((block) => block?.type === "text" && typeof block.text === "string");
        if (textBlocks.length !== 1) continue;
        let result: JsonObject | null;
        try { result = object(JSON.parse(textBlocks[0]?.text as string)); } catch { continue; }
        if (result?.success !== true || typeof result.skillId !== "string" || typeof result.path !== "string"
          || result.scope !== request.scope || !path.isAbsolute(result.path)) continue;
        const parsed = parseSkillId(result.skillId);
        if (!parsed || parsed.scope !== request.scope || parsed.slug !== request.name) continue;
        const key = `${request.eventId}:${entry.id}`;
        const location = pathKey(result.path);
        const identity = `${location}:${result.skillId}:${request.createdDate}`;
        const existing = seenEvents.get(key);
        if (existing && existing !== identity) {
          report.warnings.push("history-conflicting-event");
          report.creations = report.creations.filter((event) => event.eventId !== key);
        } else if (!existing) {
          seenEvents.set(key, identity);
          report.creations.push({ eventId: key, pathKey: location, skillId: result.skillId, scope: request.scope, createdDate: request.createdDate });
        }
      }
      if (!headerSeen && lines.every((line) => !line.trim())) report.warnings.push("history-unsupported-header");
    } catch {
      report.warnings.push("history-file-unavailable");
    }
  }
  report.warnings = [...new Set(report.warnings)];
  report.partial = report.warnings.length > 0;
  return report;
}
