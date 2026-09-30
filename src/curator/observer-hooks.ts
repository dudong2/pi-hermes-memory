import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SkillStore } from "../store/skill-store.js";
import type { InventoryRoot } from "./model.js";
import { CuratorObserver } from "./observer.js";
import type { CuratorStore } from "./store.js";

export function registerCuratorObserver(pi: ExtensionAPI, curator: CuratorStore, skills: SkillStore): CuratorObserver {
  const observer = new CuratorObserver(curator, () => {
    const roots: InventoryRoot[] = [{ scope: "global", path: skills.getGlobalSkillsDir() }];
    const project = skills.getProjectSkillsDir();
    if (project) roots.push({ scope: "project", path: project, projectName: skills.getProjectName() ?? undefined });
    return roots;
  });
  const fallback = randomUUID();
  let activeSession: string | undefined;
  let ready: Promise<void> = Promise.resolve();
  const ensure = (ctx: ExtensionContext, force = false): Promise<void> => {
    const session = ctx.sessionManager?.getSessionId?.() ?? fallback;
    if (force || session !== activeSession) {
      activeSession = session;
      ready = observer.start(session);
    }
    return ready;
  };
  pi.on("session_start", async (_event, ctx) => { await ensure(ctx, true); });
  pi.on("tool_call", async (event, ctx) => {
    await ensure(ctx);
    await observer.onToolCall(event, ctx.cwd);
  });
  pi.on("tool_result", async (event, ctx) => {
    await ensure(ctx);
    await observer.onToolResult(event, ctx.cwd);
  });
  pi.on("input", async (event, ctx) => {
    await ensure(ctx);
    await observer.onInput(event, ctx.cwd);
  });
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user") return;
    await ensure(ctx);
    await observer.onUserMessage(event.message);
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "toolResult" || !("nestedCalls" in event.message)) return;
    await ensure(ctx);
    await observer.onNestedResult(event.message.nestedCalls);
  });
  pi.on("session_shutdown", async () => {
    try { await observer.close(); } finally { curator.close(); }
  });
  return observer;
}
