import { scanSecrets } from "../store/content-scanner.js";

export function assertNoMemorySecrets(value: unknown): void {
  const findings = scanSecrets(typeof value === "string" ? value : JSON.stringify(value))
    .filter((id) => !id.startsWith("env_"));
  if (findings.length) throw new Error(`secret-bearing long-term memory rejected: ${findings.join(", ")}`);
}
