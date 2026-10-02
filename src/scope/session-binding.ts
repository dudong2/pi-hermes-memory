import type { DatabaseManager } from "../store/db.js";

// Re-label only the searchable mirror. Original JSONL entries and messages
// remain untouched, including unknown paths and previously indexed sessions.
export function rebindIndexedSessions(db: DatabaseManager): void {
  const database = db.getDb();
  const rows = database.prepare("SELECT id, cwd, project FROM sessions").all() as { id: string; cwd: string; project: string }[];
  const update = database.prepare("UPDATE sessions SET project = ? WHERE id = ?");
  const apply = () => {
    for (const row of rows) {
      const key = db.resolveSessionProject(row.cwd, row.project);
      if (key && key !== row.project) update.run(key, row.id);
    }
  };
  if (database.transaction) database.transaction(apply)(); else apply();
}
