import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { AtomicLockCoordinator, type AtomicLockLease } from "./atomic-lock-coordinator.js";
import { canonicalStoragePath } from "./canonical-storage-path.js";

/** Serialize skill mutations without retaining Curator's provenance or activity ledger. */
export class SkillMutationLock {
  private readonly currentPath: string;
  private readonly legacyPath: string;

  constructor(agentRoot: string) {
    this.currentPath = path.join(agentRoot, ".pi-hermes-locks.sqlite");
    // Until every old Pi process exits, acquire its existing skill locks too.
    this.legacyPath = path.join(agentRoot, "pi-hermes-memory", "curator", "locks.sqlite");
  }

  async withMutation<T>(roots: string[], operation: () => Promise<T>): Promise<T> {
    const keys = [...new Set(await Promise.all(roots.map(canonicalStoragePath)))].sort()
      .map((root) => `skill-root:${createHash("sha256").update(path.resolve(root)).digest("hex")}`);
    const legacyStat = fs.statSync(this.legacyPath, { throwIfNoEntry: false });
    if (legacyStat && (!legacyStat.isFile() || fs.lstatSync(this.legacyPath).isSymbolicLink() || legacyStat.nlink !== 1)) {
      throw new Error("unsafe-skill-lock");
    }
    const paths = [...(legacyStat ? [this.legacyPath] : []), this.currentPath];
    const leases: AtomicLockLease[] = [];
    try {
      for (const file of paths) {
        const coordinator = AtomicLockCoordinator.shared(file);
        for (const key of ["skill-lifecycle", ...keys]) {
          const deadline = Date.now() + 5000;
          let lease: AtomicLockLease | null = null;
          while (!lease) {
            try { lease = coordinator.tryAcquire(key, { staleMs: 0 }); }
            catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
            }
            if (!lease) {
              if (Date.now() >= deadline) throw new Error("skill-mutation-busy");
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
          leases.push(lease);
        }
        fs.chmodSync(file, 0o600);
      }
      return await operation();
    } finally {
      for (const lease of leases.reverse()) lease.release();
    }
  }
}
