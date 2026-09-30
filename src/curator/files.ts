import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseFrontmatter } from "../store/skill-utils.js";
import type { SkillSnapshot } from "./model.js";
import type { SkillScope } from "../types.js";

export const MAX_SKILL_BYTES = 512 * 1024;
export const GENERATION_FIELD = "pi-hermes-generation";
const GENERATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function pathKey(value: string): string {
  return createHash("sha256").update(path.resolve(value)).digest("hex");
}

export function generationFromText(text: string): string | null {
  const value = parseFrontmatter(text).meta[GENERATION_FIELD];
  return value && GENERATION_PATTERN.test(value) ? value : null;
}

export function withGeneration(text: string, generation: string | null): string {
  if (!generation) return text;
  if (!GENERATION_PATTERN.test(generation) || !text.startsWith("---\n")) {
    throw new Error("Invalid Curator generation metadata");
  }
  return text.replace(/^---\n/, `---\n${GENERATION_FIELD}: ${generation}\n`);
}

export async function readLimited(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error("file-read-limit");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset > maxBytes || BigInt(offset) !== before.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("file-changed-during-read");
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readGeneration(filePath: string): Promise<string | null> {
  try {
    return generationFromText((await readLimited(filePath, MAX_SKILL_BYTES)).toString("utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function snapshotSkill(options: {
  agentRoot: string; root: string; filePath: string; skillId: string; scope: SkillScope;
}): Promise<SkillSnapshot> {
  const agentRoot = await fs.realpath(options.agentRoot);
  if ((await fs.lstat(options.root)).isSymbolicLink()) throw new Error("unsafe-root");
  const root = await fs.realpath(options.root);
  const relativeRoot = path.relative(agentRoot, root);
  // Custom memoryDir may be outside the agent root. Resolve it from configuration,
  // not a persisted absolute path; rootKey still identifies the exact physical root.
  const rootRelativePath = relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot) ? "@configured" : relativeRoot;
  const relativePath = path.relative(options.root, options.filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("unsafe-path");
  const parent = await fs.realpath(path.dirname(options.filePath));
  if (parent !== path.resolve(root, path.dirname(relativePath))) throw new Error("unsafe-path");
  const before = await fs.lstat(options.filePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) throw new Error("unsafe-file");
  const bytes = await readLimited(options.filePath, MAX_SKILL_BYTES);
  const after = await fs.lstat(options.filePath, { bigint: true });
  if (before.ino !== after.ino || before.dev !== after.dev
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error("file-changed-during-read");
  }
  return {
    skillId: options.skillId, scope: options.scope,
    rootKey: pathKey(root), rootRelativePath, relativePath,
    generationId: generationFromText(bytes.toString("utf8")),
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    fileIdentity: `${after.dev}:${after.ino}:${after.birthtimeNs}:${after.ctimeNs}`,
  };
}

export function snapshotFingerprint(snapshot: SkillSnapshot): string {
  return createHash("sha256").update(JSON.stringify([
    snapshot.generationId, snapshot.skillId, snapshot.scope, snapshot.rootKey, snapshot.relativePath,
    snapshot.contentHash, snapshot.fileIdentity,
  ])).digest("hex");
}

export function sameSnapshot(record: SkillSnapshot, snapshot: SkillSnapshot): boolean {
  return record.generationId === snapshot.generationId
    && record.skillId === snapshot.skillId && record.scope === snapshot.scope
    && record.rootKey === snapshot.rootKey && record.relativePath === snapshot.relativePath
    && record.contentHash === snapshot.contentHash && record.fileIdentity === snapshot.fileIdentity;
}
