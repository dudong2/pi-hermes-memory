import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "../types.js";
import type { ResolvedScope } from "../scope/resolver.js";
import { canonicalStoragePathSync } from "../store/canonical-storage-path.js";
import { loadConfig } from "./config.js";
import { createHindsightExtension } from "./runtime.js";

export function registerHindsightIntegration(pi: ExtensionAPI,
  memory: Pick<MemoryConfig, "hindsightEnabled" | "hindsightSettingsPath" | "projectResolutionMode" | "scopeCatalogDir">,
  syncScope: (scope: ResolvedScope) => Promise<void>): void {
  // Disabled means no legacy settings reads, credential reads, queue creation,
  // network requests, or registrations colliding with the still-active owner.
  if (memory.hindsightEnabled !== true) return;
  try {
    const config = loadConfig(memory.hindsightSettingsPath);
    if (memory.projectResolutionMode !== "catalog" || !memory.scopeCatalogDir
      || canonicalStoragePathSync(memory.scopeCatalogDir) !== canonicalStoragePathSync(config.dataDir)) {
      throw new Error("Hermes and Hindsight must use the same existing Scope catalog");
    }
    createHindsightExtension({ config, syncHermesScopeStore: syncScope })(pi);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hindsight configuration unavailable";
    pi.registerCommand("memory-hindsight-status", {
      description: "Hindsight 연동을 활성화하지 못한 이유를 확인합니다.",
      handler: async (_args, ctx) => { ctx.ui.notify(`Hindsight 비활성: ${message}`, "warning"); },
    });
  }
}
