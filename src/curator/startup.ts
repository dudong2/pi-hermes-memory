import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCuratorCycle } from "./runner.js";

/** Run before resources_discover populates this process's skill cache. */
export function registerCuratorStartup(
  pi: Pick<ExtensionAPI, "on">,
  agentRoot: string,
  cycle: (root: string) => Promise<unknown> = (root) => runCuratorCycle({ agentRoot: root, mode: "startup" }),
): void {
  pi.on("session_start", async (event) => {
    // Reloads and session switches can already have a stale skill cache.
    if (event.reason === "startup") await cycle(agentRoot);
  });
}
