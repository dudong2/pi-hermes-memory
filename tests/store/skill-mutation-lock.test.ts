import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SkillMutationLock } from "../../src/store/skill-mutation-lock.ts";

test("skill mutations serialize without creating a Curator ledger", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-mutation-lock-"));
  try {
    const skills = path.join(root, "skills");
    await fs.mkdir(skills);
    const lock = new SkillMutationLock(root);
    let active = 0;
    let peak = 0;
    const work = () => lock.withMutation([skills], async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active--;
    });
    await Promise.all([work(), work()]);
    assert.equal(peak, 1);
    assert.equal((await fs.stat(path.join(root, ".pi-hermes-locks.sqlite"))).mode & 0o777, 0o600);
    await assert.rejects(fs.stat(path.join(root, "pi-hermes-memory", "curator")), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
