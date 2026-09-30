import { it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

it("preserves ordinary EXDEV moves for large files and the generation of tracked files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-curator-move-"));
  const code = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    const fs = await import('node:fs/promises');
    const { default: defaultExport, ...namedExports } = fs;
    mock.module('node:fs/promises', { defaultExport, namedExports: {
      ...namedExports,
      rename: async (from, to) => {
        if (String(from).endsWith('/SKILL.md')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
        return fs.rename(from, to);
      }
    } });
    process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(root)};
    const { SkillStore } = await import('./src/store/skill-store.ts');
    const { CuratorStore } = await import('./src/curator/store.ts');
    const root = ${JSON.stringify(root)};
    const options = { globalSkillsDir: root + '/global', piGlobalSkillsDir: root + '/external', projectSkillsDir: root + '/project', projectName: 'demo' };
    const plain = new SkillStore(options);
    const body = 'x'.repeat(512 * 1024 + 1);
    const large = await plain.create('large-move', 'Large move', body, 'project');
    assert.equal(large.success, true);
    const movedLarge = await plain.move(large.skillId, 'global');
    assert.equal(movedLarge.success, true);
    assert.equal((await plain.loadSkill(movedLarge.skillId)).body, body);
    const curator = new CuratorStore({ agentRoot: root });
    const tracked = new SkillStore({ ...options, curator });
    try {
      const created = await tracked.create('tracked-move', 'Tracked move', 'body', 'project');
      const generation = curator.list()[0].generationId;
      const moved = await tracked.move(created.skillId, 'global');
      assert.equal(moved.success, true);
      assert.equal(curator.list()[0].generationId, generation);
      assert.equal(curator.list()[0].skillId, moved.skillId);
      assert.equal(curator.list()[0].scope, 'global');
    } finally { curator.close(); mock.restoreAll(); }
  `;
  try {
    await promisify(execFile)(process.execPath, ["--experimental-test-module-mocks", "--import", "tsx", "--input-type=module", "-e", code], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 15000,
    });
  } catch (error) {
    assert.fail((error as { stderr?: string }).stderr ?? String(error));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
