import { afterEach } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScopeCatalog } from "../../src/scope/catalog.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

export async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export async function writeCatalogFixture(dataDir: string, catalog: ScopeCatalog): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "scope-catalog.json"), JSON.stringify(catalog));
}
