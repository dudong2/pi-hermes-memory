import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectProjectSkills } from "../project.js";
import * as path from "node:path";

function skillsRoot(memoryDir: string): string { return path.join(memoryDir, "skills"); }
import type { SkillStore } from "../store/skill-store.js";
import { inventorySkills } from "./inventory.js";
import { dryRunCurator } from "./dry-run.js";
import { removeUnusedSkills } from "./removal.js";
import type { CuratorPolicyConfig } from "./policy.js";
import type { CuratorStore } from "./store.js";
import type { InventoryRoot } from "./model.js";

export function registerCuratorCommand(
  pi: ExtensionAPI,
  curator: CuratorStore | null,
  skills: SkillStore,
  projectsMemoryDir?: string,
  policy?: CuratorPolicyConfig | null,
  currentPolicy?: () => CuratorPolicyConfig | null | undefined,
  projectResolver?: (cwd: string) => { name: string | null; memoryDir: string | null },
): void {
  pi.registerCommand("memory-curator", {
    description: "Curator 상태·dry-run·조건부 무알림 제거",
    handler: async (args, ctx) => {
      let text: string;
      const action = args.trim() || "status";
      if (action === "remove" && !curator) return;
      if (!["inventory", "status", "dry-run", "remove"].includes(action)) {
        text = "사용법: /memory-curator [status|inventory|dry-run|remove] — 보관·복원은 지원하지 않습니다.";
      } else if (!curator) {
        text = "Curator가 비활성화되어 있습니다(curatorEnabled: false). 기존 원장과 스킬은 유지됩니다.";
      } else {
        const roots: InventoryRoot[] = [{ scope: "global", path: skills.getGlobalSkillsDir() }];
        const project = projectResolver ? projectResolver(ctx.cwd) : detectProjectSkills(projectsMemoryDir, ctx.cwd);
        if (project.memoryDir && project.name) roots.push({ scope: "project", path: skillsRoot(project.memoryDir), projectName: project.name });
        if (action === "remove") {
          await removeUnusedSkills({ roots, curator, policy: currentPolicy ?? policy,
            basis: "calendar", allowCachedSessions: true });
          return;
        }
        if (action === "dry-run") {
          text = JSON.stringify(await dryRunCurator({ roots, curator, policy,
            basis: "calendar", allowCachedSessions: true }), null, 2);
        } else {
          const report = await inventorySkills({ roots, curator });
          text = JSON.stringify({ stage: "E", automaticArchiving: false, automaticScheduling: false,
            maintenanceTrigger: "process-start", ...report }, null, 2);
        }
      }
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else pi.sendMessage({ customType: "curator-inventory", content: text, display: true }, { triggerTurn: false });
    },
  });
}
