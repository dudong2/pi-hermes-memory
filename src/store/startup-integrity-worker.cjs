// A plain CommonJS entry point keeps workers independent of Pi's TypeScript
// loader. This connection only reads; quarantine/recovery stays with the owner.
const { parentPort, workerData } = require("node:worker_threads");

let database;
let result;
try {
  const identity = require("node:fs").statSync(workerData.dbPath);
  if (identity.dev !== workerData.dev || identity.ino !== workerData.ino) {
    result = { status: "superseded" };
  } else {
    if (workerData.bun) {
      const { Database } = require("bun:sqlite");
      database = new Database(workerData.dbPath, { readonly: true });
    } else {
      const Database = require("better-sqlite3");
      database = new Database(workerData.dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    }
    const rows = database.prepare("PRAGMA quick_check").all();
    const ok = rows.length > 0 && rows.every((row) => String(Object.values(row)[0]).toLowerCase() === "ok");
    result = { status: ok ? "ok" : "corrupt" };
  }
} catch (error) {
  const code = String(error?.code ?? "");
  const corrupt = code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB"
    || /database disk image is malformed|file is not a database|database schema is corrupt|malformed database schema|btreeinitpage/i.test(String(error?.message ?? ""));
  // Do not send raw native errors or database content across the boundary.
  result = { status: corrupt ? "corrupt" : "failed" };
} finally {
  try { database?.close(); } catch { /* The owner handles corruption recovery. */ }
}
parentPort.postMessage(result);
parentPort.close();
