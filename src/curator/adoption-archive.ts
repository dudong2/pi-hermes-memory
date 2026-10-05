import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseSkillId } from "../store/skill-utils.js";
import { normalizeCuratorPolicy } from "./policy.js";
import { pathKey, sameSnapshot, snapshotSkill } from "./files.js";
import { prepareArchiveDestination } from "./archive-files.js";
import type { InventoryRoot, SkillSnapshot } from "./model.js";
import type { CuratorStore } from "./store.js";

interface AdoptedSkill { skillId: string; snapshot: SkillSnapshot; state: "active" | "archived"; archivePath?: string; }
export interface AdoptionManifest { version: 1; source: "user-designated-hermes"; adoptedAt: string; skills: AdoptedSkill[]; }
export interface UsageEvidence { complete: boolean; lastSeenAt: Map<string, string>; }
export interface ArchiveCycleResult { archived: number; held: number; failed: number; eligible: number; }

const execFileAsync = promisify(execFile);

export async function loadAdoptedUsage(agentRoot: string, manifest: AdoptionManifest): Promise<UsageEvidence> {
  const script = fileURLToPath(new URL("../../scripts/curator-usage.mjs", import.meta.url));
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [script, "--report", "--since", manifest.adoptedAt], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentRoot }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    }));
  } catch { return { complete: false, lastSeenAt: new Map() }; }
  let report: unknown;
  try { report = JSON.parse(stdout); } catch { return { complete: false, lastSeenAt: new Map() }; }
  if (!report || typeof report !== "object" || Array.isArray(report)) return { complete: false, lastSeenAt: new Map() };
  const data = report as { start?: unknown; since?: unknown; partial?: unknown;
    unreadableFiles?: unknown; sessionFiles?: unknown; skills?: unknown };
  if (typeof data.start !== "string" || validTime(data.start) === null
    || data.start > manifest.adoptedAt || data.since !== manifest.adoptedAt
    || data.partial !== false || data.unreadableFiles !== 0
    || typeof data.sessionFiles !== "number" || data.sessionFiles < 1
    || !Array.isArray(data.skills)) return { complete: false, lastSeenAt: new Map() };
  const rows = new Map<string, string | null>();
  for (const value of data.skills) {
    if (!value || typeof value !== "object" || typeof value.id !== "string"
      || (value.lastSeenAt !== null && typeof value.lastSeenAt !== "string")) continue;
    rows.set(value.id, value.lastSeenAt);
  }
  if (manifest.skills.some((skill) => !rows.has(skill.skillId))) return { complete: false, lastSeenAt: new Map() };
  return { complete: true, lastSeenAt: new Map([...rows].filter((row): row is [string, string] => row[1] !== null)) };
}

function manifestPath(agentRoot: string): string {
  return path.join(agentRoot, "pi-hermes-memory", "curator", "adopted-archive.json");
}
function validTime(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}
async function rootsFor(skillId: string, roots: InventoryRoot[]): Promise<{ root: InventoryRoot; file: string }> {
  const parsed = parseSkillId(skillId);
  if (!parsed) throw new Error("invalid-skill-id");
  const root = roots.find((entry) => entry.scope === parsed.scope
    && (entry.projectName ?? null) === (parsed.projectName ?? null));
  if (!root) throw new Error("skill-root-unavailable");
  const file = path.join(root.path, parsed.slug, "SKILL.md");
  return { root, file };
}

export async function readAdoptionManifest(agentRoot: string): Promise<AdoptionManifest | null> {
  const file = manifestPath(agentRoot);
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("unsafe-adoption-manifest");
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(file, "utf8")); }
  catch { throw new Error("invalid-adoption-manifest"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-adoption-manifest");
  const manifest = parsed as AdoptionManifest;
  if (manifest.version !== 1 || manifest.source !== "user-designated-hermes"
    || validTime(manifest.adoptedAt) === null || !Array.isArray(manifest.skills)) throw new Error("invalid-adoption-manifest");
  return manifest;
}

async function saveManifest(agentRoot: string, manifest: AdoptionManifest): Promise<void> {
  const file = manifestPath(agentRoot);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function createAdoptionCohort(options: {
  agentRoot: string; roots: InventoryRoot[]; skillIds: string[]; now: Date;
}): Promise<AdoptionManifest> {
  const agentRoot = path.resolve(options.agentRoot);
  const adoptedAt = options.now.toISOString();
  if (!options.skillIds.length || new Set(options.skillIds).size !== options.skillIds.length) throw new Error("invalid-adoption-selection");
  if (await readAdoptionManifest(agentRoot)) throw new Error("adoption-already-initialized");
  const skills: AdoptedSkill[] = [];
  for (const skillId of options.skillIds) {
    const { root, file } = await rootsFor(skillId, options.roots);
    const snapshot = await snapshotSkill({ agentRoot, root: root.path, filePath: file, skillId, scope: root.scope });
    const entries = await fs.readdir(path.dirname(file));
    if (!entries.includes("SKILL.md")) throw new Error("skill-file-missing");
    skills.push({ skillId, snapshot, state: "active" });
  }
  const manifest: AdoptionManifest = { version: 1, source: "user-designated-hermes", adoptedAt, skills };
  const dir = path.dirname(manifestPath(agentRoot));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error("unsafe-adoption-directory");
  const file = manifestPath(agentRoot);
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(manifest, null, 2) + "\n"); }
  finally { await handle.close(); }
  return manifest;
}

async function preflight(options: {
  agentRoot: string; roots: InventoryRoot[]; record: AdoptedSkill;
}): Promise<string | null> {
  const parsed = parseSkillId(options.record.skillId);
  if (!parsed || options.record.snapshot.relativePath !== path.join(parsed.slug, "SKILL.md")) return null;
  const { root, file } = await rootsFor(options.record.skillId, options.roots);
  const snapshot = await snapshotSkill({ agentRoot: options.agentRoot, root: root.path,
    filePath: file, skillId: options.record.skillId, scope: root.scope });
  if (!sameSnapshot(options.record.snapshot, snapshot)) return null;
  const source = path.dirname(file);
  const dir = await fs.lstat(source);
  const physicalRoot = await fs.realpath(root.path);
  if (!dir.isDirectory() || dir.isSymbolicLink()
    || (await fs.realpath(source)) !== path.join(physicalRoot, path.basename(source))) return null;
  if (pathKey(await fs.realpath(root.path)) !== snapshot.rootKey) return null;
  if ((await fs.stat(root.path)).dev !== (await fs.stat(options.agentRoot)).dev) return null;
  return source;
}

export async function runAdoptedArchiveCycle(options: {
  agentRoot: string; roots: InventoryRoot[]; policy: unknown | (() => unknown);
  paused: boolean | (() => boolean); now: Date;
  curator: CuratorStore; usage: () => Promise<UsageEvidence>;
}): Promise<ArchiveCycleResult> {
  const result: ArchiveCycleResult = { archived: 0, held: 0, failed: 0, eligible: 0 };
  const manifest = await readAdoptionManifest(options.agentRoot);
  if (!manifest) return result;
  const active = manifest.skills.filter((row) => row.state === "active");
  if (!active.length) return result;
  const currentPolicy = () => normalizeCuratorPolicy(typeof options.policy === "function" ? options.policy() : options.policy);
  const isPaused = () => typeof options.paused === "function" ? options.paused() : options.paused;
  const initialPause = isPaused();
  const policy = currentPolicy();
  const adoptedAt = validTime(manifest.adoptedAt);
  const now = options.now.getTime();
  const day = 86_400_000;
  if (!policy || adoptedAt === null || !Number.isFinite(now) || now < adoptedAt) {
    result.held = active.length; return result;
  }
  const graceDays = (value: NonNullable<typeof policy>) => Math.max(value.minimumObservationDays,
    value.creationGraceDays, value.modificationGraceDays, value.adoptionGraceDays);
  if (now - adoptedAt < graceDays(policy) * day) { result.held = active.length; return result; }
  let evidence: UsageEvidence;
  try { evidence = await options.usage(); }
  catch { evidence = { complete: false, lastSeenAt: new Map() }; }
  if (!evidence.complete) { result.held = active.length; return result; }
  for (const record of active) {
    if (policy.pinnedSkillIds?.includes(record.skillId)) { result.held++; continue; }
    const activity = evidence.lastSeenAt.get(record.skillId);
    const lastUse = activity === undefined ? null : validTime(activity);
    if (activity !== undefined && (lastUse === null || lastUse > now)) { result.held++; continue; }
    const start = Math.max(adoptedAt, lastUse ?? adoptedAt);
    if (now - start < policy.inactivityDays * day) { result.held++; continue; }
    try {
      const { root } = await rootsFor(record.skillId, options.roots);
      await options.curator.withMutation([root.path], async () => {
        const latestPolicy = currentPolicy();
        if (!latestPolicy || latestPolicy.pinnedSkillIds?.includes(record.skillId)
          || now - adoptedAt < graceDays(latestPolicy) * day
          || now - start < latestPolicy.inactivityDays * day) { result.held++; return; }
        // Re-read the cohort and exact file under the shared mutation lock.
        const current = await readAdoptionManifest(options.agentRoot);
        const fresh = current?.skills.find((item) => item.skillId === record.skillId && item.state === "active");
        if (!fresh || JSON.stringify(fresh.snapshot) !== JSON.stringify(record.snapshot)) { result.held++; return; }
        const source = await preflight({ ...options, record: fresh });
        if (!source) { result.held++; return; }
        result.eligible++;
        if (initialPause || isPaused()) return;
        const destination = await prepareArchiveDestination({ agentRoot: options.agentRoot,
          skillId: record.skillId, directory: source });
        await fs.rename(source, destination);
        fresh.state = "archived";
        fresh.archivePath = path.relative(options.agentRoot, destination);
        await saveManifest(options.agentRoot, current!);
        result.archived++;
      });
    } catch { result.failed++; }
  }
  return result;
}
