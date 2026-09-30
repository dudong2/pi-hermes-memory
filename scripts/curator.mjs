#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createJiti } from "jiti";

const usage = "사용법: pi-hermes-curator [--once | --watch --interval-minutes <양수>]\nPI_CODING_AGENT_DIR의 현재 설정과 확인된 관리 대상만 사용합니다. 예약 작업을 설치하거나 삭제 결과를 알리지 않습니다.";

async function main() {
  const { values, positionals } = parseArgs({ options: {
    once: { type: "boolean" }, watch: { type: "boolean" },
    "interval-minutes": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log(usage); return; }
  if (positionals.length || (values.once && values.watch)
    || (!values.watch && values["interval-minutes"] !== undefined)
    || (values.watch && values["interval-minutes"] === undefined)) throw new Error("invalid-arguments");
  const intervalMs = values.watch ? Number(values["interval-minutes"]) * 60_000 : undefined;
  if (intervalMs !== undefined && (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 2 ** 31 - 1)) {
    throw new Error("invalid-interval");
  }
  // Use the same TypeScript runtime as Pi, declared directly so the CLI also
  // works when package-local SDK peers are absent. No agent/model is invoked.
  const jiti = createJiti(import.meta.url, { fsCache: false, tryNative: false });
  const { runCuratorCycle, runPeriodicCurator } = await jiti.import("../src/curator/runner.ts");
  const { resolveAgentRoot } = await jiti.import("../src/paths.ts");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const cycle = () => runCuratorCycle({ agentRoot: resolveAgentRoot(), signal: controller.signal });
    if (values.watch) await runPeriodicCurator({ intervalMs, signal: controller.signal, cycle });
    else if ((await cycle()).failed) process.exitCode = 1;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

main().catch(() => {
  console.error("Curator 실행 인자 또는 런타임을 확인하세요. --help로 사용법을 조회할 수 있습니다.");
  process.exitCode = 1;
});
