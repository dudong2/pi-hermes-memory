import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "../../src/hindsight/config.js";

test("parseConfig returns safe shadow defaults", () => {
  const config = parseConfig(undefined);
  assert.equal(config.mode, "shadow");
  assert.equal(config.bankId, "pi");
  assert.equal(config.shadowBankId, "pi::shadow");
  assert.equal(config.apiUrl, "http://127.0.0.1:8888");
  assert.equal(config.requestTimeoutMs, 30_000);
  assert.equal(config.markerName, ".pi-memory-scope.json");
  assert.equal(
    config.dataDir,
    join(homedir(), ".config", "pi-memory-orchestrator"),
  );
});

test("parseConfig accepts explicit active settings", () => {
  const config = parseConfig({ mode: "active", requestTimeoutMs: 10_000, maxRecallTokens: 2_048 });
  assert.equal(config.mode, "active");
  assert.equal(config.requestTimeoutMs, 10_000);
  assert.equal(config.maxRecallTokens, 2_048);
  assert.equal(config.apiUrl, DEFAULT_CONFIG.apiUrl);
});

test("parseConfig rejects invalid timeout", () => {
  assert.throws(() => parseConfig({ requestTimeoutMs: 0 }), /positive integer/);
});

test("loadConfig retains an unmigrated legacy catalog unless dataDir is explicit", () => {
  const home = mkdtempSync(join(tmpdir(), "orchestrator-config-"));
  try {
    const legacy = join(home, ".local", "share", "pi-memory-orchestrator");
    const current = join(home, ".config", "pi-memory-orchestrator");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(current, { recursive: true });
    writeFileSync(join(legacy, "scope-catalog.json"), "{}");
    const script = `import { loadConfig } from "./src/hindsight/config.ts";
const path = process.env.TEST_CONFIG_PATH;
console.log(loadConfig(path).dataDir);`;
    const run = () => {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: home,
            TEST_CONFIG_PATH: join(current, "config.json"),
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    assert.equal(run(), legacy);
    writeFileSync(join(current, "config.json"), "{}");
    assert.equal(run(), legacy);
    writeFileSync(
      join(current, "config.json"),
      JSON.stringify({ dataDir: current }),
    );
    assert.equal(run(), current);
    rmSync(join(current, "config.json"));
    writeFileSync(join(current, "scope-catalog.json"), "{}");
    assert.equal(run(), current);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
