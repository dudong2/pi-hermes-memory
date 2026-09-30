import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface ProcessOwner { pid: number; fingerprint: string | null; }
function fingerprint(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return tail[19] ?? null;
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 250, env: { ...process.env, LC_ALL: "C" },
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  }
  return null;
}
let self: ProcessOwner | undefined;
export function currentProcessOwner(): ProcessOwner {
  self ??= { pid: process.pid, fingerprint: fingerprint(process.pid) };
  return self;
}

// Unknown ownership or probe failures are protection, never evidence of exit.
export function processMayBeAlive(owner: { ownerPid?: number | null; ownerFingerprint?: string | null }): boolean {
  const pid = owner.ownerPid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  const observed = fingerprint(pid);
  return !owner.ownerFingerprint || !observed || observed === owner.ownerFingerprint;
}
