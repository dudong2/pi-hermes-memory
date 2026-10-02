import { chmod, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";

// Short filesystem transactions only: never hold this lease across HTTP.
export async function withQueueMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const path = join(await realpath(root), ".outbox-locks.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const file = await lstat(path + suffix);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("invalid-outbox-lock-storage");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const deadline = Date.now() + 5000;
  while (true) {
    let lease;
    try { lease = AtomicLockCoordinator.shared(path).tryAcquire("outbox-mutation", { staleMs: 0 }); }
    catch (error) {
      if (!["SQLITE_BUSY", "SQLITE_LOCKED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (lease) {
      try { await chmod(path, 0o600); return await operation(); }
      finally { lease.release(); }
    }
    if (Date.now() >= deadline) throw new Error("outbox-mutation-busy");
    await new Promise((done) => setTimeout(done, 10));
  }
}
