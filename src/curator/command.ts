import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectProjectSkills } from "../project.js";
import * as path from "node:path";

function skillsRoot(memoryDir: string): string { return path.join(memoryDir, "skills"); }
import type { SkillStore } from "../store/skill-store.js";
import { inventorySkills } from "./inventory.js";
import { dryRunCurator } from "./dry-run.js";
import { removeUnusedSkills } from "./removal.js";
import type { CuratorPolicyConfig, PolicyReason, PolicyReport } from "./policy.js";
import type { CuratorStore } from "./store.js";
import type { InventoryRoot } from "./model.js";

const REASON_LABELS = {
  "policy-not-configured": "정책 미설정", "invalid-policy": "정책 오류", "invalid-time": "시간 정보 확인 불가",
  "unknown-provenance": "생성 출처 확인 불가", "unverified-generation": "세대 확인 불가",
  pinned: "보호 대상으로 지정됨", "in-use": "사용 중", "observation-missing": "사용 관측 없음",
  "observation-fault": "관측 장애", "unsupported-observer": "지원되지 않는 관측",
  "observation-open": "관측 세션 열림", "stale-observation": "오래된 관측",
  "insufficient-observation": "관측 기간 부족", "creation-grace": "생성 유예기간",
  "modification-grace": "수정 유예기간", "adoption-grace": "편입 유예기간",
  "recent-activity": "최근 사용·수정", "insufficient-age": "생성 후 경과 기간 부족",
  "inventory-incomplete": "스킬 목록 조사 불완전",
} as const satisfies Record<PolicyReason, string>;

export function formatCuratorDryRun(report: PolicyReport & { warnings: string[] }): string {
  let policyStatus = "설정됨";
  if (report.policyStatus === "not-configured") policyStatus = "미설정";
  else if (report.policyStatus === "invalid") policyStatus = "설정 오류";
  const lines = [
    "Curator dry-run — 조회만 (삭제하지 않음)",
    `정책: ${policyStatus} · 후보: ${report.candidateCount}개 · 보류: ${report.heldCount}개`,
  ];
  const reasonCounts = new Map<PolicyReason, number>();
  const candidates: string[] = [];
  for (const decision of report.decisions) {
    if (decision.candidate) candidates.push(decision.skillId);
    for (const reason of decision.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  if (reasonCounts.size) {
    lines.push("보류 사유 (사유별 건수는 중복 집계):");
    const ranked = [...reasonCounts].sort((a, b) => b[1] - a[1] || REASON_LABELS[a[0]].localeCompare(REASON_LABELS[b[0]]));
    for (const [reason, count] of ranked.slice(0, 6)) lines.push(`- ${REASON_LABELS[reason]}: ${count}개`);
    if (ranked.length > 6) lines.push(`- 그 외 ${ranked.length - 6}가지 사유`);
  }
  if (candidates.length) {
    lines.push("후보 스킬 (삭제 확정 아님):");
    for (const skillId of candidates.slice(0, 5)) lines.push(`- ${skillId}`);
    if (candidates.length > 5) lines.push(`- 그 외 ${candidates.length - 5}개`);
  }
  if (report.warnings.length) {
    const warnings = report.warnings.map((warning) => warning === "observation-gap" ? "관측 공백" : warning);
    lines.push(`경고: ${warnings.slice(0, 5).join(", ")}${warnings.length > 5 ? ` 외 ${warnings.length - 5}건` : ""}`);
  }
  lines.push("상세 판정: /memory-curator dry-run --json");
  return lines.join("\n");
}

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
      const action = args.trim().replace(/\s+/g, " ") || "status";
      const detailed = action === "dry-run --json";
      if (action === "remove" && !curator) return;
      if (!["inventory", "status", "dry-run", "remove"].includes(action) && !detailed) {
        text = "사용법: /memory-curator [status|inventory|dry-run [--json]|remove] — 보관·복원은 지원하지 않습니다.";
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
        if (action === "dry-run" || detailed) {
          const report = await dryRunCurator({ roots, curator, policy,
            basis: "calendar", allowCachedSessions: true });
          text = detailed ? JSON.stringify(report, null, 2) : formatCuratorDryRun(report);
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
