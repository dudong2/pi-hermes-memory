import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

type OrchestratorMode = "shadow" | "active";

export interface OrchestratorConfig {
  mode: OrchestratorMode;
  harness: "pi";
  apiUrl: string;
  apiToken?: string;
  hindsightConfigPath: string;
  bankId: string;
  shadowBankId: string;
  requestTimeoutMs: number;
  targetTimeoutMs: number;
  maxRecallTokens: number;
  recallTypes: Array<"world" | "experience" | "observation">;
  preferObservations: boolean;
  dataDir: string;
  markerName: string;
}

const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "pi-hermes-memory",
  "config.json",
);

function detectHarness(): "pi" { return "pi"; }

export const DEFAULT_CONFIG: OrchestratorConfig = {
  mode: "shadow",
  harness: detectHarness(),
  apiUrl: "http://127.0.0.1:8888",
  hindsightConfigPath: join(homedir(), ".hindsight", "coding-agent.json"),
  bankId: "pi",
  shadowBankId: "pi::shadow",
  requestTimeoutMs: 30_000,
  targetTimeoutMs: 5_000,
  maxRecallTokens: 4_096,
  recallTypes: ["observation"],
  preferObservations: false,
  dataDir: join(homedir(), ".config", "pi-hermes-memory"),
  markerName: ".pi-memory-scope.json",
};

function positiveInteger(
  value: unknown,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validatedRecallTypes(
  value: OrchestratorConfig["recallTypes"],
): OrchestratorConfig["recallTypes"] {
  const allowedTypes = new Set(["world", "experience", "observation"]);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((type) => !allowedTypes.has(type))
  ) {
    throw new Error(
      "recallTypes must contain world, experience, or observation",
    );
  }
  return [...new Set(value)];
}

function configurationChoice<T extends string>(
  value: T,
  choices: readonly T[],
  message: string,
): T {
  if (!choices.includes(value)) throw new Error(message);
  return value;
}

export function parseConfig(input: unknown): OrchestratorConfig {
  if (input === undefined || input === null) return { ...DEFAULT_CONFIG };
  if (typeof input !== "object" || Array.isArray(input))
    throw new Error("config must be an object");
  const raw = input as Partial<OrchestratorConfig>;
  const mode = configurationChoice(
    raw.mode ?? DEFAULT_CONFIG.mode,
    ["shadow", "active"],
    "mode must be shadow or active",
  );
  const harness = configurationChoice(
    raw.harness ?? DEFAULT_CONFIG.harness,
    ["pi"],
    "harness must be pi",
  );
  const recallTypes = validatedRecallTypes(
    raw.recallTypes ?? DEFAULT_CONFIG.recallTypes,
  );
  if (
    raw.preferObservations !== undefined &&
    typeof raw.preferObservations !== "boolean"
  ) {
    throw new Error("preferObservations must be boolean");
  }

  for (const name of ["bankId", "shadowBankId", "apiUrl", "hindsightConfigPath", "dataDir", "markerName"] as const) {
    const value = raw[name] ?? DEFAULT_CONFIG[name];
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  }
  if (!isAbsolute(raw.dataDir ?? DEFAULT_CONFIG.dataDir)) throw new Error("dataDir must be absolute");
  if ((raw.bankId ?? DEFAULT_CONFIG.bankId) === (raw.shadowBankId ?? DEFAULT_CONFIG.shadowBankId)) {
    throw new Error("shadowBankId must differ from bankId");
  }
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    mode,
    harness,
    recallTypes,
    preferObservations:
      raw.preferObservations ?? DEFAULT_CONFIG.preferObservations,
    requestTimeoutMs: positiveInteger(
      raw.requestTimeoutMs,
      DEFAULT_CONFIG.requestTimeoutMs,
      "requestTimeoutMs",
    ),
    targetTimeoutMs: positiveInteger(
      raw.targetTimeoutMs,
      DEFAULT_CONFIG.targetTimeoutMs,
      "targetTimeoutMs",
    ),
    maxRecallTokens: positiveInteger(
      raw.maxRecallTokens,
      DEFAULT_CONFIG.maxRecallTokens,
      "maxRecallTokens",
    ),
  };
}

const LEGACY_DATA_DIR = join(
  homedir(),
  ".local",
  "share",
  "pi-memory-orchestrator",
);

function preserveUnmigratedCatalog(
  config: OrchestratorConfig,
): OrchestratorConfig {
  if (
    !existsSync(join(config.dataDir, "scope-catalog.json")) &&
    existsSync(join(LEGACY_DATA_DIR, "scope-catalog.json"))
  ) {
    return { ...config, dataDir: LEGACY_DATA_DIR };
  }
  return config;
}

export function loadConfig(
  path = process.env.PI_MEMORY_ORCHESTRATOR_CONFIG || DEFAULT_CONFIG_PATH,
): OrchestratorConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const config = parseConfig(parsed);
    return parsed && typeof parsed === "object" && "dataDir" in parsed
      ? config
      : preserveUnmigratedCatalog(config);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return preserveUnmigratedCatalog({
        ...DEFAULT_CONFIG,
        harness: detectHarness(),
      });
    throw error;
  }
}

export function resolveHindsightConnection(config: OrchestratorConfig): {
  apiUrl: string;
  apiToken?: string;
} {
  if (config.apiToken)
    return { apiUrl: config.apiUrl, apiToken: config.apiToken };
  try {
    const parsed = JSON.parse(
      readFileSync(config.hindsightConfigPath, "utf8"),
    ) as {
      apiUrl?: unknown;
      apiToken?: unknown;
      apiKey?: unknown;
    };
    const apiUrl =
      typeof parsed.apiUrl === "string" && parsed.apiUrl.trim()
        ? parsed.apiUrl
        : config.apiUrl;
    let token: string | undefined;
    if (typeof parsed.apiToken === "string" && parsed.apiToken.trim()) {
      token = parsed.apiToken;
    } else if (typeof parsed.apiKey === "string" && parsed.apiKey.trim()) {
      token = parsed.apiKey;
    }
    if (token) return { apiUrl, apiToken: token };
    return { apiUrl };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { apiUrl: config.apiUrl };
    throw error;
  }
}
