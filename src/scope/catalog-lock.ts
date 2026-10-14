import { chmod, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Stats } from "node:fs";
import { AtomicLockCoordinator, type AtomicLockLease } from "../store/atomic-lock-coordinator.js";

function sameFile(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.ctimeMs === second.ctimeMs;
}

function exited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function reclaimExitedOwner(lockPath: string): Promise<boolean> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("invalid-scope-catalog-lock");
    const content = await readFile(lockPath, "utf8");
    const pidLine = content.split("\n", 1)[0];
    if (!/^\d+$/.test(pidLine) || !exited(Number(pidLine))) return false;
    const fresh = await lstat(lockPath);
    if (!sameFile(info, fresh)) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function waitForLease(lockPath: string, deadline: number): Promise<AtomicLockLease> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const root = await realpath(dirname(lockPath));
  const dbPath = join(root, ".scope-catalog-locks.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const info = await lstat(dbPath + suffix);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("invalid-scope-lock-storage");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  while (true) {
    try {
      const coordinator = AtomicLockCoordinator.shared(dbPath);
      const lease = coordinator.tryAcquire(basename(lockPath), { staleMs: 0 });
      if (lease) {
        try { await chmod(dbPath, 0o600); } catch (error) { lease.release(); throw error; }
        return lease;
      }
    } catch (error) {
      if (!["SQLITE_BUSY", "SQLITE_LOCKED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for lock: ${lockPath}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

// The SQLite lease serializes new writers and dead legacy-file reclamation.
// Retain the original PID-file protocol as a compatibility gate, but never
// infer process exit from elapsed time. Activation still requires one owner.
export async function acquireCatalogLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 5000;
  const lease = await waitForLease(lockPath, deadline);
  try {
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try { await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`); }
        catch (error) { await handle.close(); throw error; }
        const identity = await handle.stat();
        return async () => {
          try {
            await handle.close();
            try { if (sameFile(identity, await lstat(lockPath))) await unlink(lockPath); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          } finally { lease.release(); }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await reclaimExitedOwner(lockPath)) continue;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for lock: ${lockPath}`);
        await new Promise((done) => setTimeout(done, 25));
      }
    }
  } catch (error) { lease.release(); throw error; }
}
