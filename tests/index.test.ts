import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { appendAutoConsolidationFailureLog, formatAutoConsolidationFailure, shouldWarnAutoConsolidationFailure } from "../src/auto-consolidation-warning.js";

describe("shouldWarnAutoConsolidationFailure", () => {
  it("warns for failed consolidation by default", () => {
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(true, false),
      true,
    );
  });

  it("suppresses only the session warning when disabled", () => {
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(false, false),
      false,
    );
  });

  it("never warns for a successful consolidation", () => {
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(true, true),
      false,
    );
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(false, true),
      false,
    );
  });

  it("warns for a partial consolidation even when progress was made", () => {
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(true, true, true),
      true,
    );
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(false, true, true),
      false,
      "the warning flag still governs",
    );
    assert.strictEqual(
      shouldWarnAutoConsolidationFailure(true, true, false),
      false,
      "a clean successful run stays quiet",
    );
  });
});

describe("formatAutoConsolidationFailure", () => {
  it("includes the session scope, target and reason on one log line", () => {
    const message = formatAutoConsolidationFailure(
      "failure", "scope_ticket-macro\nspoof", "Consolidation subprocess timed out after 180000ms.",
    );
    assert.match(message, /target="failure"/);
    assert.match(message, /sessionScope="scope_ticket-macro\\nspoof"/);
    assert.match(message, /timed out after 180000ms/);
    assert.doesNotMatch(message, /\n/);
  });

  it("persists a bounded failure record without child output", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-consolidation-log-test-"));
    try {
      const logPath = path.join(dir, "nested", "failures.jsonl");
      await appendAutoConsolidationFailureLog(
        "failure", "scope_ticket-macro", "Consolidation subprocess timed out after 180000ms. private child output", logPath,
      );
      await appendAutoConsolidationFailureLog(
        "project", "scope_ai-chat", "Consolidation subprocess was cancelled.", logPath,
      );
      await appendAutoConsolidationFailureLog(
        "user", null, "Consolidation subprocess timed out after 180000ms.", logPath,
      );
      await appendAutoConsolidationFailureLog(
        "failure", "scope_ticket-macro",
        "round 1 changed 2 entries; Consolidation subprocess timed out after 60000ms. private child output",
        logPath,
      );
      const records = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.strictEqual(records.length, 4);
      assert.match(records[0].timestamp, /^\d{4}-\d\d-\d\dT/);
      assert.deepStrictEqual({ target: records[0].target, sessionScope: records[0].sessionScope, reason: records[0].reason }, {
        target: "failure", sessionScope: "scope_ticket-macro", reason: "Consolidation subprocess timed out after 180000ms.",
      });
      assert.strictEqual(records[1].reason, "Consolidation subprocess was cancelled.");
      assert.strictEqual(records[2].reason, "Consolidation subprocess timed out after 180000ms.");
      assert.strictEqual(records[3].reason, "Consolidation subprocess timed out after 60000ms.");
      assert.strictEqual((await fs.stat(logPath)).mode & 0o777, 0o600);
      assert.doesNotMatch(await fs.readFile(logPath, "utf8"), /private child output/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
