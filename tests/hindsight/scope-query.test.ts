import assert from "node:assert/strict";
import test from "node:test";
import {
  buildScopeQueryPlan,
  hasWorkspaceWideIntent,
} from "../../src/scope/query.js";
import { scope } from "./fixtures.js";

test("default plan includes only the current Scope", () => {
  const plan = buildScopeQueryPlan(scope, "Fix the login screen");
  assert.deepEqual(plan.tags, [scope.scopeTag]);
  assert.deepEqual(plan.expandedScopes, []);
});

test("an explicit project selector expands every scope in that project", () => {
  const plan = buildScopeQueryPlan(
    scope,
    "project:product authentication history",
  );
  assert.deepEqual(plan.expandedScopes, [
    "product/backend",
    "product/infrastructure",
  ]);
  assert.ok(plan.tags.includes("scope:id:scope_backend"));
  assert.ok(plan.tags.includes("scope:id:scope_infrastructure"));
});

test("an explicit qualified scope selector expands only that scope", () => {
  const plan = buildScopeQueryPlan(
    scope,
    "scope:product/backend authentication",
  );
  assert.deepEqual(plan.expandedScopes, ["product/backend"]);
  assert.ok(plan.tags.includes("scope:id:scope_backend"));
  assert.ok(!plan.tags.includes("scope:id:scope_infrastructure"));
});

test("malformed percent encoding in a selector fails safely", () => {
  const plan = buildScopeQueryPlan(scope, "scope:%E0%A4%A query");
  assert.deepEqual(plan.tags, [scope.scopeTag]);
});

test("an unambiguous natural project mention expands its scopes", () => {
  const plan = buildScopeQueryPlan(
    scope,
    "What did product decide about auth?",
  );
  assert.ok(plan.tags.includes("scope:id:scope_backend"));
  assert.ok(plan.tags.includes("scope:id:scope_infrastructure"));
});

test("an unambiguous scope alias expands only that scope", () => {
  const plan = buildScopeQueryPlan(scope, "What failed in infra?");
  assert.deepEqual(plan.expandedScopes, ["product/infrastructure"]);
});

test("project-wide intent expands current project scopes", () => {
  assert.equal(hasWorkspaceWideIntent("프로젝트 전체 구조를 비교해줘"), true);
  const plan = buildScopeQueryPlan(scope, "Compare the entire project");
  assert.equal(plan.workspaceWide, true);
  assert.equal(plan.tags.length, 3);
});

test("current mode never expands another scope", () => {
  const plan = buildScopeQueryPlan(scope, "project:product", {
    mode: "current",
  });
  assert.deepEqual(plan.tags, [scope.scopeTag]);
});
