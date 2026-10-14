import type { TagFilterGroup, TagFilterLeaf } from "../hindsight/client.js";
import type { ResolvedScope, ScopeReference } from "./resolver.js";

type ScopeQueryMode =
  | "auto"
  | "current"
  | "project"
  | "all"
  | "workspace"
  | "repositories";

export interface ScopeQueryOptions {
  mode?: ScopeQueryMode;
  repositoryIds?: string[];
}

export interface ScopeQueryPlan {
  tags: string[];
  tagGroups: TagFilterGroup[];
  expandedScopes: string[];
  expandedRepositories: string[];
  workspaceWide: boolean;
}

function leaf(tag: string): TagFilterLeaf {
  return { tags: [tag], match: "all_strict" };
}

function key(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replaceAll("_", "-")
    .replace(/\s+/g, "-");
}

function mentions(query: string, value: string): boolean {
  const normalized = query.normalize("NFC").toLocaleLowerCase("en-US");
  const candidate = value.normalize("NFC").toLocaleLowerCase("en-US");
  if (!candidate) return false;
  let offset = normalized.indexOf(candidate);
  while (offset >= 0) {
    const before = offset > 0 ? normalized[offset - 1] : undefined;
    const after = normalized[offset + candidate.length];
    const word = (character: string | undefined) =>
      character !== undefined && /[\p{L}\p{N}]/u.test(character);
    if (!word(before) && !word(after)) return true;
    offset = normalized.indexOf(candidate, offset + candidate.length);
  }
  return false;
}

function explicitSelectors(query: string): {
  projects: string[];
  scopes: string[];
} {
  const projects: string[] = [];
  const scopes: string[] = [];
  for (const match of query.matchAll(/(?:^|\s)(project|scope):([^\s]+)/giu)) {
    const raw = (match[2] ?? "").replace(/[.,;!?]+$/u, "");
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Keep malformed percent-encoding literal rather than failing recall.
    }
    if (match[1]?.toLowerCase() === "project") projects.push(value);
    else scopes.push(value);
  }
  return { projects, scopes };
}

function projectKeys(scope: ScopeReference): string[] {
  return scope.projectName
    ? [scope.projectName, ...scope.projectAliases].map(key)
    : [];
}

function scopeKeys(scope: ScopeReference): string[] {
  return [scope.scopeName, scope.qualifiedName, ...scope.aliases].map(key);
}

function selectExplicitScopes(
  knownScopes: ScopeReference[],
  explicit: ReturnType<typeof explicitSelectors>,
): ScopeReference[] {
  const selected = new Map<string, ScopeReference>();
  for (const projectName of explicit.projects) {
    const wanted = key(projectName);
    for (const candidate of knownScopes) {
      if (projectKeys(candidate).includes(wanted))
        selected.set(candidate.scopeId, candidate);
    }
  }
  for (const scopeName of explicit.scopes) {
    const wanted = key(scopeName);
    for (const candidate of knownScopes) {
      if (scopeKeys(candidate).includes(wanted))
        selected.set(candidate.scopeId, candidate);
    }
  }
  return [...selected.values()];
}

function selectMentionedScopes(
  knownScopes: ScopeReference[],
  query: string,
): ScopeReference[] {
  const matchedProjects = new Set<string>();
  for (const candidate of knownScopes) {
    if (!candidate.projectId) continue;
    const names = [candidate.projectName ?? "", ...candidate.projectAliases];
    if (names.some((name) => mentions(query, name)))
      matchedProjects.add(candidate.projectId);
  }
  if (matchedProjects.size === 1) {
    const [projectId] = matchedProjects;
    return knownScopes.filter((candidate) => candidate.projectId === projectId);
  }
  const matchedScopes = knownScopes.filter((candidate) =>
    [candidate.qualifiedName, ...candidate.aliases].some((name) =>
      mentions(query, name),
    ),
  );
  return matchedScopes.length === 1 ? matchedScopes : [];
}

function selectedScopes(
  scope: ResolvedScope,
  query: string,
  mode: ScopeQueryMode,
): ScopeReference[] {
  if (mode === "current") return [];
  if (mode === "all") return scope.knownScopes;
  if (mode === "project" || mode === "workspace") return scope.projectScopes;
  if (mode === "repositories") {
    const requested = new Set(scope.knownRepositoryIds);
    return scope.knownScopes.filter((candidate) =>
      candidate.repositoryId ? requested.has(candidate.repositoryId) : false,
    );
  }

  const explicit = explicitSelectors(query);
  if (explicit.projects.length || explicit.scopes.length)
    return selectExplicitScopes(scope.knownScopes, explicit);
  return selectMentionedScopes(scope.knownScopes, query);
}

const PROJECT_WIDE_INTENT =
  /\b(?:all|entire)\s+(?:project|repositories|repos)\b|(?:프로젝트|저장소|리포지토리|레포)\s*(?:전체|전반)|(?:모든|전체)\s*(?:저장소|리포지토리|레포)/iu;
export const hasWorkspaceWideIntent =
  PROJECT_WIDE_INTENT.test.bind(PROJECT_WIDE_INTENT);

export function buildScopeQueryPlan(
  scope: ResolvedScope,
  query: string,
  options: ScopeQueryOptions = {},
): ScopeQueryPlan {
  let mode = options.mode ?? "auto";
  if (mode === "auto" && hasWorkspaceWideIntent(query)) mode = "project";
  const selected = selectedScopes(scope, query, mode);
  if (options.mode === "repositories" && options.repositoryIds) {
    const requested = new Set(options.repositoryIds);
    selected.splice(
      0,
      selected.length,
      ...scope.knownScopes.filter((candidate) =>
        candidate.repositoryId ? requested.has(candidate.repositoryId) : false,
      ),
    );
  }

  const tags = [
    scope.scopeTag,
    ...selected.map((candidate) => candidate.memoryTag),
  ].filter((tag, index, all) => all.indexOf(tag) === index);
  return {
    tags,
    tagGroups: [{ or: tags.map(leaf) }],
    expandedScopes: selected
      .flatMap((candidate) =>
        candidate.scopeId !== scope.scopeId ? [candidate.qualifiedName] : [],
      )
      .sort((a, b) => a.localeCompare(b)),
    expandedRepositories: selected
      .flatMap((candidate) =>
        candidate.repositoryId && candidate.repositoryId !== scope.repositoryId
          ? [candidate.repositoryId]
          : [],
      )
      .sort((a, b) => a.localeCompare(b)),
    workspaceWide: mode === "project",
  };
}
