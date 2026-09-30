import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { AtomicLockCoordinator, type AtomicLockLease } from "../store/atomic-lock-coordinator.js";
import { canonicalStoragePath, canonicalStoragePathSync } from "../store/canonical-storage-path.js";
import { isBunRuntime, loadBetterSqlite3 } from "../store/sqlite-native.js";
import { pathKey, sameSnapshot, snapshotFingerprint } from "./files.js";
import { currentProcessOwner, processMayBeAlive } from "./process-owner.js";
import { OBSERVATION_GAP_REASONS, SUPPORTED_ACTIVITY_PATHS } from "./model.js";
import type { ActivityKind, ActivityRecord, CuratorRecord, ObservationGap, ObservationGapReason, ObservationRun, ObservationSummary, SkillMutation, SkillMutationTracker, SkillSnapshot } from "./model.js";

interface Statement {
  run(...params: unknown[]): void;
  all(...params: unknown[]): unknown[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
type DatabaseCtor = new (file: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => Database;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS curator_metadata (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  INSERT OR IGNORE INTO curator_metadata VALUES ('schema_version', '1');
  CREATE TABLE IF NOT EXISTS skills (
    generation_id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL, scope TEXT NOT NULL,
    root_key TEXT NOT NULL, root_relative_path TEXT NOT NULL, relative_path TEXT NOT NULL,
    content_hash TEXT NOT NULL, file_identity TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
    created_at TEXT NOT NULL, modified_at TEXT NOT NULL, last_activity_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS active_skill_location
    ON skills(root_key, relative_path) WHERE state = 'active';
`;

const OBSERVATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS observation_runs (
    run_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'faulted')), producer_version TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS observation_gaps (
    gap_key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES observation_runs(run_id),
    generation_id TEXT REFERENCES skills(generation_id), reason TEXT NOT NULL, at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS skill_activity (
    event_key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES observation_runs(run_id),
    generation_id TEXT NOT NULL REFERENCES skills(generation_id),
    kind TEXT NOT NULL CHECK (kind IN ('read', 'view', 'skill-command')), at TEXT NOT NULL
  );
  UPDATE curator_metadata SET value = '2' WHERE key = 'schema_version' AND value = '1';
`;

function openDatabase(file: string, readonly = false): Database {
  const require = createRequire(import.meta.url);
  const Ctor = isBunRuntime()
    ? (require("bun:sqlite") as { Database: DatabaseCtor }).Database
    : loadBetterSqlite3({ requireImpl: require }) as DatabaseCtor;
  return new Ctor(file, readonly ? { readonly: true, fileMustExist: true } : undefined);
}

const SELECT = `SELECT generation_id AS generationId, skill_id AS skillId, scope,
  root_key AS rootKey, root_relative_path AS rootRelativePath, relative_path AS relativePath,
  content_hash AS contentHash, file_identity AS fileIdentity, state,
  created_at AS createdAt, modified_at AS modifiedAt, last_activity_at AS lastActivityAt
  FROM skills ORDER BY created_at, generation_id`;

export class CuratorStore implements SkillMutationTracker {
  readonly agentRoot: string;
  readonly dbPath: string;
  private db: Database | null = null;
  private locks: AtomicLockCoordinator | null = null;
  private failed = false;
  private readonly now: () => Date;

  constructor(options: { agentRoot: string; now?: () => Date }) {
    this.agentRoot = path.resolve(options.agentRoot);
    this.dbPath = path.join(this.agentRoot, "pi-hermes-memory", "curator", "curator.db");
    this.now = options.now ?? (() => new Date());
  }

  noteFailure(): void { this.failed = true; }
  getWarnings(): string[] { return this.failed ? ["ledger-record-failed"] : []; }

  // Inspection never creates or rebuilds a ledger. Corruption remains an error.
  list(): CuratorRecord[] {
    this.assertDirectory();
    this.assertFile(this.dbPath);
    if (!fs.existsSync(this.dbPath)) return [];
    const db = this.db ?? openDatabase(this.dbPath, true);
    try {
      this.assertVersion(db);
      return db.prepare(SELECT).all() as CuratorRecord[];
    } finally {
      if (db !== this.db) db.close();
    }
  }

  private assertDirectory(): void {
    const expected = path.join(canonicalStoragePathSync(this.agentRoot), "pi-hermes-memory", "curator");
    if (canonicalStoragePathSync(path.dirname(this.dbPath)) !== expected) throw new Error("unsafe-curator-directory");
  }

  private assertFile(file: string): void {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("unsafe-curator-file");
  }

  private assertVersion(db: Database): "1" | "2" | "3" {
    const versions = db.prepare("SELECT value FROM curator_metadata WHERE key = 'schema_version'").all();
    const version = (versions[0] as { value?: string } | undefined)?.value;
    if (version !== "1" && version !== "2" && version !== "3") throw new Error("unsupported-curator-schema");
    return version;
  }

  private open(): Database {
    if (this.db) return this.db;
    this.assertDirectory();
    this.assertFile(this.dbPath);
    const directory = path.dirname(this.dbPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const db = openDatabase(this.dbPath);
    try {
      fs.chmodSync(this.dbPath, 0o600);
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'curator_metadata'").all().length > 0) {
        this.assertVersion(db);
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(SCHEMA);
        db.exec(OBSERVATION_SCHEMA);
        const columns = db.prepare("PRAGMA table_info(observation_runs)").all() as { name: string }[];
        if (!columns.some((column) => column.name === "owner_pid")) db.exec("ALTER TABLE observation_runs ADD COLUMN owner_pid INTEGER");
        if (!columns.some((column) => column.name === "owner_fingerprint")) db.exec("ALTER TABLE observation_runs ADD COLUMN owner_fingerprint TEXT");
        // Current judgment state is retained, but no deletion/audit history is kept.
        db.exec(`CREATE TABLE IF NOT EXISTS cache_owners (owner_pid INTEGER PRIMARY KEY, owner_fingerprint TEXT);
          DROP TABLE IF EXISTS operations;
          DELETE FROM skill_activity WHERE generation_id IN (SELECT generation_id FROM skills WHERE state = 'deleted');
          UPDATE observation_gaps SET generation_id = NULL WHERE generation_id IN (SELECT generation_id FROM skills WHERE state = 'deleted');
          DELETE FROM skills WHERE state = 'deleted';
          UPDATE curator_metadata SET value = '3' WHERE key = 'schema_version';`);
        this.assertVersion(db);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  async withMutation<T>(roots: string[], operation: () => Promise<T>): Promise<T> {
    this.assertDirectory();
    const directory = path.dirname(this.dbPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const lockPath = path.join(directory, "locks.sqlite");
    this.assertFile(lockPath);
    this.locks ??= AtomicLockCoordinator.shared(lockPath);
    const rootKeys = [...new Set(await Promise.all(roots.map(canonicalStoragePath)))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
      .map((identity) => `skill-root:${pathKey(identity)}`);
    const identities = ["skill-lifecycle", ...rootKeys];
    const leases: AtomicLockLease[] = [];
    try {
      for (const identity of identities) {
        const deadline = Date.now() + 5000;
        let lease: AtomicLockLease | null = null;
        while (!lease) {
          try {
            lease = this.locks.tryAcquire(identity, { staleMs: 0 });
          } catch (error) {
            // Concurrent first opens can collide during the coordinator WAL setup.
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
      fs.chmodSync(lockPath, 0o600);
      // Never steal from a live or suspended writer solely because time elapsed.
      return await operation();
    } finally {
      for (const lease of leases.reverse()) lease.release();
    }
  }

  async record(event: SkillMutation): Promise<void> {
    const snapshot = event.kind === "delete" ? event.before : event.after;
    if (!snapshot?.generationId) return;
    const existing = this.list().find((row) => row.generationId === snapshot.generationId);
    if (event.kind === "create" && existing) return;
    const current = existing?.state === "active" ? existing : null;
    if (event.kind !== "create" && (!current || !event.before || !sameSnapshot(current, event.before))) return;
    if (event.kind !== "create" && event.kind !== "delete" && event.before && sameSnapshot(event.before, snapshot)) return;
    const db = this.open();
    const stamp = this.now().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (event.kind === "create") {
        const previous = db.prepare("SELECT generation_id FROM skills WHERE root_key = ? AND relative_path = ?")
          .all(snapshot.rootKey, snapshot.relativePath) as { generation_id: string }[];
        for (const row of previous) this.eraseGeneration(db, row.generation_id);
        db.prepare(`INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`)
          .run(snapshot.generationId, snapshot.skillId, snapshot.scope, snapshot.rootKey, snapshot.rootRelativePath,
            snapshot.relativePath, snapshot.contentHash, snapshot.fileIdentity, stamp, stamp);
      } else if (event.kind === "delete") {
        this.eraseGeneration(db, snapshot.generationId);
      } else {
        db.prepare(`UPDATE skills SET skill_id = ?, scope = ?, root_key = ?, root_relative_path = ?,
          relative_path = ?, content_hash = ?, file_identity = ?, modified_at = ?,
          last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END
          WHERE generation_id = ?`)
          .run(snapshot.skillId, snapshot.scope, snapshot.rootKey, snapshot.rootRelativePath,
            snapshot.relativePath, snapshot.contentHash, snapshot.fileIdentity, stamp, stamp, stamp, snapshot.generationId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private inspectObservation<T>(query: string): T[] {
    this.assertDirectory();
    this.assertFile(this.dbPath);
    if (!fs.existsSync(this.dbPath)) return [];
    const db = this.db ?? openDatabase(this.dbPath, true);
    try {
      if (this.assertVersion(db) === "1") return [];
      return db.prepare(query).all() as T[];
    } finally {
      if (db !== this.db) db.close();
    }
  }

  readSnapshot(): { records: CuratorRecord[]; observation: ObservationSummary } {
    this.assertDirectory();
    this.assertFile(this.dbPath);
    const empty: ObservationSummary = { runs: [], gaps: [], supportedPaths: SUPPORTED_ACTIVITY_PATHS, allPathsObserved: false };
    if (!fs.existsSync(this.dbPath)) return { records: [], observation: empty };
    // Use one read-only SQLite snapshot for activity timestamps and coverage.
    // A new activity or generation must not be combined with an older row read.
    const db = openDatabase(this.dbPath, true);
    try {
      db.exec("BEGIN");
      const version = this.assertVersion(db);
      const records = db.prepare(SELECT).all() as CuratorRecord[];
      const observation = version === "1" ? empty : {
        runs: db.prepare(version === "3"
          ? `SELECT run_id AS runId, session_key AS sessionKey, started_at AS startedAt,
            ended_at AS endedAt, state, producer_version AS producerVersion,
            owner_pid AS ownerPid, owner_fingerprint AS ownerFingerprint FROM observation_runs ORDER BY started_at, run_id`
          : `SELECT run_id AS runId, session_key AS sessionKey, started_at AS startedAt,
            ended_at AS endedAt, state, producer_version AS producerVersion FROM observation_runs ORDER BY started_at, run_id`
        ).all() as ObservationRun[],
        gaps: db.prepare(`SELECT run_id AS runId, generation_id AS generationId, reason, at
          FROM observation_gaps ORDER BY at, gap_key`).all() as ObservationGap[],
        supportedPaths: SUPPORTED_ACTIVITY_PATHS, allPathsObserved: false as const,
      };
      db.exec("COMMIT");
      return { records, observation };
    } finally {
      db.close();
    }
  }

  observations(): ObservationSummary { return this.readSnapshot().observation; }

  registerCacheOwner(): void {
    if (!this.list().some((record) => record.state === "active")) return;
    const owner = currentProcessOwner();
    this.open().prepare("INSERT OR REPLACE INTO cache_owners VALUES (?, ?)").run(owner.pid, owner.fingerprint);
  }

  hasCachedSessions(): boolean {
    if (this.observations().runs.some((run) => processMayBeAlive(run))) return true;
    if (!fs.existsSync(this.dbPath)) return false;
    const db = this.db ?? openDatabase(this.dbPath, true);
    try {
      if (this.assertVersion(db) !== "3") return true;
      const owners = db.prepare("SELECT owner_pid AS ownerPid, owner_fingerprint AS ownerFingerprint FROM cache_owners")
        .all() as { ownerPid: number; ownerFingerprint: string | null }[];
      return owners.some((owner) => processMayBeAlive(owner));
    } finally { if (db !== this.db) db.close(); }
  }

  private eraseGeneration(db: Database, generationId: string): void {
    db.prepare("DELETE FROM skill_activity WHERE generation_id = ?").run(generationId);
    db.prepare("UPDATE observation_gaps SET generation_id = NULL WHERE generation_id = ?").run(generationId);
    db.prepare("DELETE FROM skills WHERE generation_id = ?").run(generationId);
  }

  forgetGeneration(expected: CuratorRecord): boolean {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = (db.prepare(SELECT).all() as CuratorRecord[]).find((row) => row.generationId === expected.generationId);
      if (!current || current.state !== "active" || snapshotFingerprint(current) !== snapshotFingerprint(expected)
        || current.lastActivityAt !== expected.lastActivityAt || current.modifiedAt !== expected.modifiedAt) {
        db.exec("COMMIT");
        return false;
      }
      this.eraseGeneration(db, current.generationId);
      db.exec("COMMIT");
      return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  activities(): ActivityRecord[] {
    return this.inspectObservation<ActivityRecord>(`SELECT event_key AS eventKey, run_id AS runId,
      generation_id AS generationId, kind, at FROM skill_activity ORDER BY at, event_key`);
  }

  beginObservation(runId: string, sessionKey: string): void {
    if (!/^[0-9a-f-]{36}$/.test(runId) || !/^[0-9a-f]{64}$/.test(sessionKey)) throw new Error("invalid-observation-identity");
    const owner = currentProcessOwner();
    this.open().prepare(`INSERT OR IGNORE INTO observation_runs
      (run_id, session_key, started_at, ended_at, state, producer_version, owner_pid, owner_fingerprint)
      VALUES (?, ?, ?, NULL, 'open', 'pi-hooks-v1', ?, ?)`)
      .run(runId, sessionKey, this.now().toISOString(), owner.pid, owner.fingerprint);
  }

  private insertGap(db: Database, runId: string, reason: ObservationGapReason, generationId: string | null, stamp: string): void {
    db.prepare("INSERT OR IGNORE INTO observation_gaps VALUES (?, ?, ?, ?, ?)")
      .run(`${runId}:${reason}:${generationId ?? 'all'}`, runId, generationId, reason, stamp);
    db.prepare("UPDATE observation_runs SET state = 'faulted' WHERE run_id = ? AND ended_at IS NULL").run(runId);
  }

  private clockFloor(db: Database, runId: string): string {
    const rows = db.prepare(`SELECT started_at, (SELECT MAX(at) FROM skill_activity WHERE run_id = ?) AS latest
      FROM observation_runs WHERE run_id = ?`).all(runId, runId) as { started_at: string; latest: string | null }[];
    if (!rows.length) throw new Error("unknown-observation");
    return rows[0].latest && rows[0].latest > rows[0].started_at ? rows[0].latest : rows[0].started_at;
  }

  recordGap(runId: string, reason: ObservationGapReason, generationId: string | null = null): void {
    if (!OBSERVATION_GAP_REASONS.includes(reason)) throw new Error("invalid-observation-gap");
    const db = this.open();
    const stamp = this.now().toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.insertGap(db, runId, reason, generationId, stamp);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // Called under the lifecycle mutation lock. Process exit is not successful
  // observation: retire unfinished runs at their last known event, faulted,
  // without counting time spent offline or repairing uncertain ownership.
  reconcileExitedProcesses(): void {
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const run of this.observations().runs) {
        if (run.endedAt !== null || processMayBeAlive(run)) continue;
        const floor = this.clockFloor(db, run.runId);
        this.insertGap(db, run.runId, "pending-at-session-end", null, floor);
        db.prepare("UPDATE observation_runs SET ended_at = ?, state = 'faulted' WHERE run_id = ? AND ended_at IS NULL")
          .run(floor, run.runId);
      }
      const owners = db.prepare("SELECT owner_pid AS ownerPid, owner_fingerprint AS ownerFingerprint FROM cache_owners")
        .all() as { ownerPid: number; ownerFingerprint: string | null }[];
      for (const owner of owners) {
        if (!processMayBeAlive(owner)) db.prepare("DELETE FROM cache_owners WHERE owner_pid = ?").run(owner.ownerPid);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  endObservation(runId: string): void {
    const db = this.open();
    const floor = this.clockFloor(db, runId);
    const stamp = this.now().toISOString();
    if (stamp < floor) this.recordGap(runId, "clock-regression");
    db.prepare(`UPDATE observation_runs SET ended_at = ?,
      state = CASE WHEN state = 'faulted' THEN 'faulted' ELSE 'closed' END WHERE run_id = ? AND ended_at IS NULL`)
      .run(stamp < floor ? floor : stamp, runId);
  }

  recordActivity(runId: string, eventKey: string, kind: ActivityKind, snapshot: SkillSnapshot): boolean {
    if (!/^[0-9a-f]{64}$/.test(eventKey) || !["read", "view", "skill-command"].includes(kind)) throw new Error("invalid-activity");
    const db = this.open();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = (db.prepare(SELECT).all() as CuratorRecord[]).find((row) => row.state === "active" && sameSnapshot(row, snapshot));
      const run = db.prepare("SELECT ended_at FROM observation_runs WHERE run_id = ?").all(runId) as { ended_at: string | null }[];
      if (!current || run.length !== 1 || run[0].ended_at !== null || db.prepare("SELECT event_key FROM skill_activity WHERE event_key = ?").all(eventKey).length) {
        db.exec("COMMIT");
        return false;
      }
      let stamp = this.now().toISOString();
      const floor = this.clockFloor(db, runId);
      const latest = current.lastActivityAt && current.lastActivityAt > floor ? current.lastActivityAt : floor;
      if (stamp < latest) {
        this.insertGap(db, runId, "clock-regression", current.generationId, stamp);
        stamp = latest;
      }
      db.prepare("INSERT INTO skill_activity VALUES (?, ?, ?, ?, ?)").run(eventKey, runId, current.generationId, kind, stamp);
      db.prepare(`UPDATE skills SET last_activity_at = CASE
        WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END WHERE generation_id = ?`)
        .run(stamp, stamp, current.generationId);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
    // AtomicLockCoordinator.shared owns process-wide handles, not this store.
    this.locks = null;
  }
}
