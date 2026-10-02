import type { ScopedHindsightProvider } from "./provider.js";
import type { ResolvedScope } from "../scope/resolver.js";

export interface ToolResultEventLike {
  toolName: string;
  toolCallId: string;
  input?: unknown;
  details?: unknown;
  isError?: boolean;
}

export interface ProjectMemoryMirror {
  action: "add" | "replace";
  content: string;
  oldText?: string;
  identity: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function successfulProjectWrite(
  event: ToolResultEventLike,
): Record<string, unknown> | null {
  if (event.isError) return null;
  if (event.toolName !== "memory_add" && event.toolName !== "memory_replace")
    return null;
  const input = record(event.input);
  const details = record(event.details);
  if (!input || !details || details.success !== true) return null;
  if (input.target !== "project" || details.target !== "project") return null;
  return input;
}

export function projectMemoryMirrorFromResult(
  event: ToolResultEventLike,
): ProjectMemoryMirror | null {
  const input = successfulProjectWrite(event);
  if (!input) return null;
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) return null;
  const action = event.toolName === "memory_add" ? "add" : "replace";
  if (action === "add") {
    return { action, content, identity: `bounded-memory:${event.toolCallId}` };
  }
  const oldText =
    typeof input.old_text === "string" ? input.old_text.trim() : "";
  if (!oldText) return null;
  return {
    action,
    content,
    oldText,
    identity: `bounded-memory:${event.toolCallId}`,
  };
}

export function formatProjectMemoryMirror(mirror: ProjectMemoryMirror): string {
  if (mirror.action === "add")
    return `Project working-memory fact added: ${mirror.content}`;
  return [
    "Project working-memory fact corrected.",
    `Previous text: ${mirror.oldText}`,
    `New authoritative text: ${mirror.content}`,
    "The new text supersedes the previous text for the current project scope.",
  ].join("\n");
}

export async function enqueueProjectMemoryMirror(
  event: ToolResultEventLike,
  provider: ScopedHindsightProvider,
  scope: ResolvedScope,
): Promise<boolean> {
  const mirror = projectMemoryMirrorFromResult(event);
  if (!mirror) return false;
  await provider.enqueueExplicit(scope, {
    identity: mirror.identity,
    content: formatProjectMemoryMirror(mirror),
  });
  return true;
}
