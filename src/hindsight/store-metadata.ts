import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { ResolvedScope } from "../scope/resolver.js";
import { safeScopeKey } from "../scope/project-binding.js";

// Transfer only the current Scope descriptor, never merge legacy memory or
// skills during startup. Storage identity remains scopeId across reassignment.
export async function syncScopeStoreMetadata(scope: ResolvedScope, projectsRoot: string): Promise<void> {
  if (!isAbsolute(projectsRoot) || !safeScopeKey(scope.scopeId) || !scope.projectId || !scope.projectName) {
    throw new Error("invalid-scope-store-binding");
  }
  const directory = join(projectsRoot, scope.scopeId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, ".pi-memory-scope-store.json");
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify({ version: 1, scopeId: scope.scopeId, scopeName: scope.scopeName,
    projectId: scope.projectId, projectName: scope.projectName, qualifiedName: `${scope.projectName}/${scope.scopeName}` }, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, destination);
}
