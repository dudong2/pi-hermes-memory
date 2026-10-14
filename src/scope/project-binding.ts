import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryConfig } from "../types.js";
import { detectProject, type ProjectInfo } from "../project.js";
import { resolveProjectsRoot } from "../paths.js";
import { DEFAULT_MARKER_NAME, parseScopeMarker, type ScopeCatalog, type ScopeRecord } from "./catalog.js";
import { resolveGitContext } from "./git.js";

export type ProjectResolutionConfig = Pick<MemoryConfig, "projectResolutionMode" | "scopeCatalogDir" | "projectsMemoryDir">;
export interface ScopeProjectInfo extends ProjectInfo { displayName?: string; scopeId?: string; }
const EMPTY: ScopeProjectInfo = { name: null, memoryDir: null };

export function safeScopeKey(value: unknown): value is string {
  // The inherited resolver also emits canonical path-derived IDs. Their
  // namespace delimiter is not traversal and must not invalidate the catalog.
  return typeof value === "string" && (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    || /^path:[a-f0-9]{64}$/.test(value));
}

function canonical(directory: string): string {
  try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
}

function within(directory: string, root: string): boolean {
  const relative = path.relative(root, directory);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Read-only during coexistence: no registration, marker repair, promotion,
// legacy-folder merge or catalog writes. Stage 3 will transfer write ownership.
export class ProjectScopeBinding {
  private catalog: ScopeCatalog = { projects: {}, scopes: {} };
  private sessionKeys = new Map<string, string | null>();
  readonly scoped: boolean;
  available = false;

  constructor(private readonly config: ProjectResolutionConfig,
    private readonly projectsRoot = resolveProjectsRoot(config.projectsMemoryDir)) {
    this.scoped = config.projectResolutionMode !== undefined && config.projectResolutionMode !== "cwd";
    this.refresh();
  }

  refresh(): void {
    this.catalog = { projects: {}, scopes: {} };
    this.available = false;
    this.sessionKeys.clear();
    if (this.config.projectResolutionMode !== "catalog" || !this.config.scopeCatalogDir
      || !path.isAbsolute(this.config.scopeCatalogDir)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.config.scopeCatalogDir, "scope-catalog.json"), "utf8"));
      if (!raw || !raw.projects || !raw.scopes || Array.isArray(raw.projects) || Array.isArray(raw.scopes)
        || typeof raw.projects !== "object" || typeof raw.scopes !== "object") return;
      for (const [key, project] of Object.entries(raw.projects)) {
        const entry = project as ScopeCatalog["projects"][string];
        if (!entry || entry.projectId !== key || typeof entry.name !== "string"
          || !Array.isArray(entry.aliases) || !entry.aliases.every((item) => typeof item === "string")) return;
      }
      for (const [key, record] of Object.entries(raw.scopes)) {
        const scope = record as ScopeRecord;
        if (!scope || !safeScopeKey(key) || scope.scopeId !== key || !scope.projectId || !raw.projects[scope.projectId]
          || !["directory", "repository"].includes(scope.kind) || typeof scope.name !== "string"
          || !Array.isArray(scope.paths) || !scope.paths.every((item) => typeof item === "string" && path.isAbsolute(item))
          || !Array.isArray(scope.aliases) || !scope.aliases.every((item) => typeof item === "string")
          || typeof scope.memoryTag !== "string" || !scope.memoryTag.trim()
          || (scope.kind === "repository" && (typeof scope.repositoryId !== "string" || !scope.repositoryId))) return;
        const marker = parseScopeMarker(scope.marker);
        if (marker.scopeId !== key || marker.projectId !== scope.projectId || marker.kind !== scope.kind) return;
      }
      this.catalog = raw;
      this.available = true;
    } catch { /* Unavailable/corrupt identity disables scoped binding, never cwd fallback. */ }
  }

  keys(): ReadonlySet<string> { return new Set(Object.keys(this.catalog.scopes)); }

  resolve(cwd?: string): ScopeProjectInfo {
    if (!this.scoped) return detectProject(this.config.projectsMemoryDir, cwd);
    if (!cwd || this.config.projectResolutionMode !== "catalog") return { ...EMPTY };
    try {
      const git = resolveGitContext(cwd);
      const root = canonical(git?.mainRoot ?? cwd);
      if (path.dirname(root) === root) return { ...EMPTY };
      const markerPath = path.join(root, DEFAULT_MARKER_NAME);
      let record: ScopeRecord | undefined;
      if (fs.existsSync(markerPath)) {
        const marker = parseScopeMarker(JSON.parse(fs.readFileSync(markerPath, "utf8")));
        record = this.catalog.scopes[marker.scopeId];
        if (!record || record.projectId !== marker.projectId || record.kind !== marker.kind) return { ...EMPTY };
      } else {
        const matches = Object.values(this.catalog.scopes).filter((candidate) =>
          candidate.paths.some((item) => canonical(item) === root)
          || (git && candidate.kind === "repository" && candidate.repositoryId === git.repositoryId));
        if (matches.length !== 1) return { ...EMPTY };
        record = matches[0];
      }
      if (record.kind === "repository" && (!git || record.repositoryId !== git.repositoryId)) return { ...EMPTY };
      if (record.kind === "directory" && git) return { ...EMPTY };
      if (!record.projectId || !safeScopeKey(record.scopeId)) return { ...EMPTY };
      const project = this.catalog.projects[record.projectId];
      if (!project) return { ...EMPTY };
      return { name: record.scopeId, scopeId: record.scopeId,
        displayName: `${project.name}/${record.name}`,
        memoryDir: path.join(this.projectsRoot, record.scopeId) };
    } catch { return { ...EMPTY }; }
  }

  selector(value: string): string {
    if (!this.scoped) return value;
    if (Object.prototype.hasOwnProperty.call(this.catalog.scopes, value)) return value;
    const wanted = value.normalize("NFC").toLocaleLowerCase("en-US");
    const matches = Object.values(this.catalog.scopes).filter((scope) => {
      const project = scope.projectId ? this.catalog.projects[scope.projectId] : undefined;
      if (!project) return false;
      const names = [scope.name, ...(scope.aliases ?? [])];
      const qualified = [project.name, ...(project.aliases ?? [])].flatMap((name) => names.map((scopeName) => `${name}/${scopeName}`));
      return [...names, ...qualified].some((name) => name.normalize("NFC").toLocaleLowerCase("en-US") === wanted);
    });
    if (matches.length !== 1) throw new Error("Scope selector is missing or ambiguous; use an exact scopeId or Project/Scope");
    return matches[0].scopeId;
  }

  sessionProject(cwd: string): string | null {
    if (this.sessionKeys.has(cwd)) return this.sessionKeys.get(cwd)!;
    let key: string | null = null;
    if (fs.existsSync(cwd)) key = this.resolve(cwd).name;
    else {
      const matches = Object.values(this.catalog.scopes).filter((scope) => scope.paths.some((root) =>
        scope.kind === "repository" ? within(path.resolve(cwd), path.resolve(root)) : path.resolve(cwd) === path.resolve(root)));
      if (matches.length === 1) key = matches[0].scopeId;
    }
    this.sessionKeys.set(cwd, key);
    return key;
  }
}
