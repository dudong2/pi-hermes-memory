import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { canonicalizeGitRemote, resolveGitContext } from "../../src/scope/git.js";
import { pathWorkspaceId } from "../../src/scope/marker.js";
import { tempRoot } from "./fixtures.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("canonicalizeGitRemote normalizes SSH and HTTPS remotes", () => {
  assert.equal(
    canonicalizeGitRemote("git@github.com:Dudong2/LuckyCat.git"),
    "github.com/dudong2/luckycat",
  );
  assert.equal(
    canonicalizeGitRemote("https://GitHub.com/Dudong2/LuckyCat.git"),
    "github.com/dudong2/luckycat",
  );
  assert.equal(canonicalizeGitRemote("file:///tmp/repo"), undefined);
});

test("legacy path IDs remain deterministic for migration", async () => {
  const home = await tempRoot("memory-scope-home-");
  const root = join(home, "workspace", "notes");
  assert.equal(pathWorkspaceId(root, home), pathWorkspaceId(root, home));
  assert.match(pathWorkspaceId(root, home), /^path:[0-9a-f]{64}$/);
});

test("linked worktrees share the main repository identity", async () => {
  const root = await tempRoot("memory-scope-worktree-");
  const main = join(root, "main");
  const linked = join(root, "linked");
  git(root, "init", "-q", main);
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  git(
    main,
    "remote",
    "add",
    "origin",
    "git@github.com:dudong2/worktree-test.git",
  );
  execFileSync("sh", ["-c", "printf 'test\\n' > README.md"], { cwd: main });
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "initial");
  git(main, "worktree", "add", "-q", "-b", "linked-test", linked);

  assert.equal(
    resolveGitContext(linked)?.repositoryId,
    resolveGitContext(main)?.repositoryId,
  );
  assert.equal(
    resolveGitContext(linked)?.commonDir,
    resolveGitContext(main)?.commonDir,
  );
});
