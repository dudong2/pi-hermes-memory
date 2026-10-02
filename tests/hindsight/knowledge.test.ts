import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureKnowledgeViews,
  type KnowledgeApi,
} from "../../src/hindsight/knowledge.js";
import type {
  KnowledgeNode,
  KnowledgePageRequest,
} from "../../src/hindsight/client.js";
import { scope } from "./fixtures.js";

class FakeKnowledgeApi implements KnowledgeApi {
  roots: KnowledgeNode[] = [];
  pages: KnowledgePageRequest[] = [];
  next = 1;
  async knowledgeTree(): Promise<{ roots: KnowledgeNode[] }> {
    return { roots: this.roots };
  }
  async createKnowledgeFolder(
    _bank: string,
    request: { name: string; parent_id?: string },
  ): Promise<Record<string, unknown>> {
    const node: KnowledgeNode = {
      id: `node-${this.next++}`,
      name: request.name,
      kind: "folder",
      parent_id: request.parent_id,
      children: [],
    };
    if (request.parent_id) {
      const parent = this.find(this.roots, request.parent_id);
      parent?.children?.push(node);
    } else this.roots.push(node);
    return node;
  }
  async createKnowledgePage(
    _bank: string,
    request: KnowledgePageRequest,
  ): Promise<Record<string, unknown>> {
    const node: KnowledgeNode = {
      id: `node-${this.next++}`,
      name: request.name,
      kind: "page",
      parent_id: request.parent_id,
      children: [],
      tags: request.tags,
    };
    this.find(this.roots, request.parent_id!)?.children?.push(node);
    this.pages.push(request);
    return node;
  }
  async deleteKnowledgeNode(
    _bank: string,
    nodeId: string,
  ): Promise<Record<string, unknown>> {
    const remove = (nodes: KnowledgeNode[]): boolean => {
      const index = nodes.findIndex((node) => node.id === nodeId);
      if (index >= 0) {
        nodes.splice(index, 1);
        return true;
      }
      return nodes.some((node) => remove(node.children ?? []));
    };
    return { deleted: remove(this.roots) };
  }
  find(nodes: KnowledgeNode[], id: string): KnowledgeNode | undefined {
    for (const node of nodes) {
      if (node.id === id) return node;
      const nested = this.find(node.children ?? [], id);
      if (nested) return nested;
    }
    return undefined;
  }
}

test("a repository marker creates one strictly filtered knowledge page", async () => {
  const api = new FakeKnowledgeApi();
  assert.deepEqual(await ensureKnowledgeViews(api, "bank", scope), {
    createdFolders: 3,
    createdPages: 1,
  });
  assert.deepEqual(await ensureKnowledgeViews(api, "bank", scope), {
    createdFolders: 0,
    createdPages: 0,
  });
  assert.equal(api.pages.length, 1);
  assert.deepEqual(
    api.pages.map((page) => page.tags),
    [[scope.scopeTag]],
  );
  for (const page of api.pages) {
    assert.equal(page.trigger?.tags_match, "all_strict");
    assert.deepEqual(page.trigger?.fact_types, ["observation"]);
    assert.equal(page.trigger?.mode, "delta");
  }
});

test("renaming a repository removes the stale generated Knowledge page", async () => {
  const api = new FakeKnowledgeApi();
  await ensureKnowledgeViews(api, "bank", scope);
  const renamed: typeof scope = {
    ...scope,
    repositoryId: "github.com/acme/frontend-renamed",
  };

  await ensureKnowledgeViews(api, "bank", renamed);

  const project = api.roots[0]?.children?.[0];
  const scopeFolder = project?.children?.[0];
  assert.deepEqual(
    scopeFolder?.children?.map((node) => node.name),
    ["Repository: acme/frontend-renamed"],
  );
});

test("reassigning a Scope removes its stale Knowledge location", async () => {
  const api = new FakeKnowledgeApi();
  await ensureKnowledgeViews(api, "bank", scope);
  const reassigned: typeof scope = {
    ...scope,
    projectId: "project_platform",
    projectName: "platform",
    marker: {
      ...scope.marker,
      projectId: "project_platform",
      updatedAt: "2026-09-16T12:00:00.000Z",
    },
  };

  await ensureKnowledgeViews(api, "bank", reassigned);

  const root = api.roots.find((node) => node.name === "Coding Projects");
  assert.deepEqual(
    root?.children?.map((node) => node.name),
    ["platform [project_platform]"],
  );
  assert.equal(
    root?.children?.[0]?.children?.[0]?.name,
    `${scope.scopeName} [${scope.scopeId}]`,
  );
});
