import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { parseSkillId } from "../store/skill-utils.js";

/** Return a private, non-discovered destination on the same filesystem. */
export async function prepareArchiveDestination(options: {
  agentRoot: string; skillId: string; directory: string;
}): Promise<string> {
  const parsed = parseSkillId(options.skillId);
  if (!parsed || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(parsed.slug)
    || (parsed.scope === "project" && (!parsed.projectName || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(parsed.projectName)))) {
    throw new Error("invalid-archive-skill-id");
  }
  const agentRoot = path.resolve(options.agentRoot);
  const segments = parsed.scope === "global" ? ["global", parsed.slug]
    : ["project", parsed.projectName!, parsed.slug];
  const parent = path.join(agentRoot, "pi-hermes-memory", "curator", "archive", ...segments);
  const relative = path.relative(agentRoot, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe-archive-directory");
  const source = await fs.lstat(options.directory);
  const agent = await fs.stat(agentRoot);
  if (!source.isDirectory() || source.isSymbolicLink() || source.dev !== agent.dev) throw new Error("unsafe-archive-source");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const physicalRoot = await fs.realpath(agentRoot);
  const physicalParent = await fs.realpath(parent);
  if (physicalParent !== path.join(physicalRoot, relative)) {
    throw new Error("unsafe-archive-directory");
  }
  const destination = path.join(parent, randomUUID());
  try { await fs.lstat(destination); throw new Error("archive-collision"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return destination;
}
