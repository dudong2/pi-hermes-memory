import type {
  HindsightClient,
  KnowledgeNode,
  KnowledgePageRequest,
} from "./client.js";
import type { ResolvedScope } from "../scope/resolver.js";

export interface KnowledgeApi {
  knowledgeTree(
    bankId: string,
    signal?: AbortSignal,
  ): Promise<{ roots: KnowledgeNode[] }>;
  createKnowledgeFolder(
    bankId: string,
    request: { name: string; parent_id?: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  createKnowledgePage(
    bankId: string,
    request: KnowledgePageRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  deleteKnowledgeNode?(
    bankId: string,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface KnowledgeViewResult {
  createdFolders: number;
  createdPages: number;
}

function nodeId(response: Record<string, unknown>): string {
  if (typeof response.id === "string") return response.id;
  const node = response.node;
  if (
    node &&
    typeof node === "object" &&
    "id" in node &&
    typeof node.id === "string"
  ) {
    return node.id;
  }
  throw new Error("Hindsight knowledge API response has no node id");
}

function findChild(
  nodes: KnowledgeNode[],
  name: string,
  kind: "folder" | "page",
): KnowledgeNode | undefined {
  return nodes.find((node) => node.kind === kind && node.name === name);
}

async function ensureFolder(
  api: KnowledgeApi,
  bankId: string,
  siblings: KnowledgeNode[],
  name: string,
  parentId: string | undefined,
  signal?: AbortSignal,
): Promise<{ id: string; children: KnowledgeNode[]; created: boolean }> {
  const existing = findChild(siblings, name, "folder");
  if (existing)
    return {
      id: existing.id,
      children: existing.children ?? [],
      created: false,
    };
  const response = await api.createKnowledgeFolder(
    bankId,
    { name, ...(parentId ? { parent_id: parentId } : {}) },
    signal,
  );
  return { id: nodeId(response), children: [], created: true };
}

async function ensurePage(
  api: KnowledgeApi,
  bankId: string,
  siblings: KnowledgeNode[],
  request: KnowledgePageRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  if (findChild(siblings, request.name, "page")) return false;
  await api.createKnowledgePage(bankId, request, signal);
  return true;
}

function pageTrigger() {
  return {
    mode: "delta" as const,
    refresh_after_consolidation: true,
    min_refresh_interval_seconds: 3_600,
    fact_types: ["observation" as const],
    tags_match: "all_strict" as const,
    keep_trace: true,
  };
}

async function retireGeneratedPages(
  api: KnowledgeApi,
  bankId: string,
  siblings: KnowledgeNode[],
  currentPageName: string,
  scope: ResolvedScope,
  signal?: AbortSignal,
): Promise<void> {
  if (!api.deleteKnowledgeNode) return;
  for (const candidatePage of siblings) {
    const tags = Array.isArray(candidatePage.tags) ? candidatePage.tags : [];
    const generatedPage =
      candidatePage.name === "Scope overview" ||
      candidatePage.name.startsWith("Repository: ");
    if (
      candidatePage.kind === "page" &&
      candidatePage.name !== currentPageName &&
      generatedPage &&
      tags.includes(scope.scopeTag)
    ) {
      await api.deleteKnowledgeNode(bankId, candidatePage.id, signal);
    }
  }
}

async function retireScopeFolders(
  api: KnowledgeApi,
  bankId: string,
  siblings: KnowledgeNode[],
  scope: ResolvedScope,
  signal?: AbortSignal,
): Promise<void> {
  if (!api.deleteKnowledgeNode) return;
  const currentProjectName = `${scope.projectName} [${scope.projectId}]`;
  const scopeIdSuffix = ` [${scope.scopeId}]`;
  for (const candidateProject of siblings) {
    if (
      candidateProject.kind !== "folder" ||
      candidateProject.name === currentProjectName
    ) {
      continue;
    }
    const children = candidateProject.children ?? [];
    const staleScope = children.find(
      (child) => child.kind === "folder" && child.name.endsWith(scopeIdSuffix),
    );
    if (!staleScope) continue;
    await api.deleteKnowledgeNode(
      bankId,
      children.length === 1 ? candidateProject.id : staleScope.id,
      signal,
    );
  }
}

export async function ensureKnowledgeViews(
  api: KnowledgeApi | HindsightClient,
  bankId: string,
  scope: ResolvedScope,
  signal?: AbortSignal,
): Promise<KnowledgeViewResult> {
  const tree = await api.knowledgeTree(bankId, signal);
  let createdFolders = 0;
  let createdPages = 0;
  const root = await ensureFolder(
    api,
    bankId,
    tree.roots,
    "Coding Projects",
    undefined,
    signal,
  );
  if (root.created) createdFolders++;

  if (!scope.projectId || !scope.projectName) {
    throw new Error(`scope has no project: ${scope.scopeId}`);
  }
  const project = await ensureFolder(
    api,
    bankId,
    root.children,
    `${scope.projectName} [${scope.projectId}]`,
    root.id,
    signal,
  );
  if (project.created) createdFolders++;
  const scopeFolder = await ensureFolder(
    api,
    bankId,
    project.children,
    `${scope.scopeName} [${scope.scopeId}]`,
    project.id,
    signal,
  );
  if (scopeFolder.created) createdFolders++;
  const currentPageName = scope.repositoryId
    ? `Repository: ${scope.repositoryId.split("/").slice(-2).join("/")}`
    : "Scope overview";
  if (
    await ensurePage(
      api,
      bankId,
      scopeFolder.children,
      {
        name: currentPageName,
        source_query:
          "Maintain a concise current scope overview covering architecture, conventions, decisions, pitfalls, corrections, and active initiatives. Explain temporal changes rather than silently replacing history.",
        parent_id: scopeFolder.id,
        tags: [scope.scopeTag],
        max_tokens: 2_048,
        trigger: pageTrigger(),
      },
      signal,
    )
  )
    createdPages++;

  await retireGeneratedPages(
    api,
    bankId,
    scopeFolder.children,
    currentPageName,
    scope,
    signal,
  );
  await retireScopeFolders(api, bankId, root.children, scope, signal);

  return { createdFolders, createdPages };
}
