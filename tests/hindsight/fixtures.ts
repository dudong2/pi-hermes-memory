import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScopeCatalog } from "../../src/scope/catalog.js";
import type { ResolvedScope, ScopeReference } from "../../src/scope/resolver.js";

export async function writeCatalogFixture(
  dataDir: string,
  records: Pick<ScopeCatalog, "projects" | "scopes"> = {
    projects: {},
    scopes: {},
  },
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "scope-catalog.json"), JSON.stringify(records));
}

const backend: ScopeReference = {
  scopeId: "scope_backend",
  scopeName: "backend",
  qualifiedName: "product/backend",
  aliases: [],
  projectId: "project_product",
  projectName: "product",
  projectAliases: [],
  memoryTag: "scope:id:scope_backend",
  kind: "repository",
  repositoryId: "github.com/dudong2/backend",
};

const frontend: ScopeReference = {
  scopeId: "scope_frontend",
  scopeName: "frontend",
  qualifiedName: "product/frontend",
  aliases: [],
  projectId: "project_product",
  projectName: "product",
  projectAliases: [],
  memoryTag: "scope:id:scope_frontend",
  kind: "repository",
  repositoryId: "github.com/dudong2/frontend",
};

const infrastructure: ScopeReference = {
  scopeId: "scope_infrastructure",
  scopeName: "infrastructure",
  qualifiedName: "product/infrastructure",
  aliases: ["infra"],
  projectId: "project_product",
  projectName: "product",
  projectAliases: [],
  memoryTag: "scope:id:scope_infrastructure",
  kind: "repository",
  repositoryId: "github.com/dudong2/infrastructure",
};

export const scope: ResolvedScope = {
  workspaceRoot: "/work/product/frontend",
  markerPath: "/work/product/frontend/.pi-memory-scope.json",
  marker: {
    version: 2,
    scopeId: frontend.scopeId,
    projectId: frontend.projectId,
    scopeName: frontend.scopeName,
    kind: "repository",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  },
  scopeId: frontend.scopeId,
  scopeName: frontend.scopeName,
  projectId: frontend.projectId,
  projectName: frontend.projectName,
  legacyHermesNames: ["frontend"],
  workspaceTag: frontend.memoryTag,
  repositoryId: frontend.repositoryId,
  repositoryTag: frontend.memoryTag,
  git: null,
  scopeTag: frontend.memoryTag,
  kind: "repository",
  ancestors: [],
  knownRepositoryIds: [
    backend.repositoryId!,
    frontend.repositoryId!,
    infrastructure.repositoryId!,
  ],
  workspaceRepositoryIds: [
    backend.repositoryId!,
    frontend.repositoryId!,
    infrastructure.repositoryId!,
  ],
  knownScopes: [backend, frontend, infrastructure],
  projectScopes: [backend, frontend, infrastructure],
};
