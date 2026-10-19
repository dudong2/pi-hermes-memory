import type { DatabaseManager } from "../store/db.js";

// Re-label only the searchable mirror. Original JSONL entries and messages
// remain untouched, including unknown paths and previously indexed sessions.
// Startup supplies its cwd so opening one project never probes every historical
// repository. Omitting cwd retains the full sweep for explicit migration/repair.
export function rebindIndexedSessions(db: DatabaseManager, cwd?: string): void {
  const database = db.getDb();
  const rows = (cwd === undefined
    ? database.prepare("SELECT id, cwd, project FROM sessions").all()
    : database.prepare("SELECT id, cwd, project FROM sessions WHERE cwd = ?").all(cwd)) as { id: string; cwd: string; project: string }[];
  const update = database.prepare("UPDATE sessions SET project = ? WHERE id = ?");
  const apply = () => {
    for (const row of rows) {
      const key = db.resolveSessionProject(row.cwd, row.project);
      if (key && key !== row.project) update.run(key, row.id);
    }
  };
  if (database.transaction) database.transaction(apply)(); else apply();
}
