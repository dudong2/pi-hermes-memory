export interface HindsightClientOptions {
  apiUrl: string;
  apiToken?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RetainItem {
  content: string;
  timestamp?: string;
  context?: string;
  metadata?: Record<string, string>;
  document_id?: string;
  tags?: string[];
  observation_scopes?: "per_tag" | "combined" | "shared" | string[][];
  update_mode?: "replace" | "append";
}

export interface RetainRequest {
  items: RetainItem[];
  async: boolean;
  operation_id?: string;
}

type TagMatch = "any" | "all" | "any_strict" | "all_strict" | "exact";

export interface TagFilterLeaf {
  tags: string[];
  match: TagMatch;
}

export type TagFilterGroup =
  | TagFilterLeaf
  | { and: TagFilterGroup[] }
  | { or: TagFilterGroup[] }
  | { not: TagFilterGroup };

export interface RecallRequest {
  query: string;
  types?: Array<"world" | "experience" | "observation">;
  prefer_observations?: boolean;
  budget?: "low" | "mid" | "high";
  max_tokens?: number;
  query_timestamp?: string;
  tags?: string[];
  tags_match?: TagMatch;
  tag_groups?: TagFilterGroup[];
}

export interface RecallMemory {
  id?: string;
  memory_id?: string;
  text: string;
  fact_type?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface RecallResponse {
  results: RecallMemory[];
  [key: string]: unknown;
}

export interface OperationStatus {
  status: string;
  error?: unknown;
  [key: string]: unknown;
}

export interface KnowledgeNode {
  id: string;
  name: string;
  kind: "folder" | "page";
  parent_id?: string | null;
  children?: KnowledgeNode[];
  [key: string]: unknown;
}

export interface KnowledgeTreeResponse {
  roots: KnowledgeNode[];
}

export interface KnowledgePageRequest {
  name: string;
  source_query: string;
  parent_id?: string;
  tags?: string[];
  max_tokens?: number;
  trigger?: {
    mode?: "full" | "delta";
    refresh_after_consolidation?: boolean;
    min_refresh_interval_seconds?: number;
    fact_types?: Array<"world" | "experience" | "observation">;
    tags_match?: TagMatch;
    tag_groups?: TagFilterGroup[];
    keep_trace?: boolean;
  };
}

export interface UpdateMemoryRequest {
  text?: string;
  context?: string;
  occurred_start?: string;
  occurred_end?: string;
  fact_type?: "world" | "experience";
  entities?: string[];
  resolve_entities?: boolean;
  state?: "invalidated" | "valid";
  reason?: string;
}

export class HindsightHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly responseBody: unknown,
  ) {
    super(`Hindsight ${method} ${path} failed with HTTP ${status}`);
    this.name = "HindsightHttpError";
  }
}

async function parseResponse<T>(
  response: Response,
  method: string,
  path: string,
): Promise<T> {
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!response.ok)
    throw new HindsightHttpError(response.status, method, path, parsed);
  return (parsed ?? {}) as T;
}

export class HindsightClient {
  readonly #apiUrl: string;
  readonly #apiToken?: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HindsightClientOptions) {
    let url: URL;
    try {
      url = new URL(options.apiUrl);
    } catch (error) {
      throw new Error("Hindsight apiUrl must be a valid URL", { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Hindsight apiUrl must use HTTP(S)");
    if (url.username || url.password) throw new Error("Hindsight apiUrl must not contain credentials");
    this.#apiUrl = url.toString().replace(/\/$/, "");
    this.#apiToken = options.apiToken?.trim() || undefined;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.#request("GET", "/health", undefined, signal);
  }

  async retain(
    bankId: string,
    request: RetainRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#request(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
      request,
      signal,
    );
  }

  async recall(
    bankId: string,
    request: RecallRequest,
    signal?: AbortSignal,
  ): Promise<RecallResponse> {
    const response = await this.#request<Record<string, unknown>>(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
      request,
      signal,
    );
    return {
      ...response,
      results: Array.isArray(response.results)
        ? (response.results as RecallMemory[])
        : [],
    };
  }

  async operationStatus(
    bankId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationStatus> {
    const response = await this.#request<Record<string, unknown>>(
      "GET",
      `/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`,
      undefined,
      signal,
    );
    return { ...response, status: String(response.status ?? "") };
  }

  async cancelOperation(
    bankId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#request(
      "DELETE",
      `/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`,
      undefined,
      signal,
    );
  }

  async importDocuments(
    bankId: string,
    archive: Uint8Array,
    filename: string,
    onConflict: "skip" | "replace" | "new-id" = "skip",
    callerSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    const form = new FormData();
    const bytes = archive.buffer.slice(
      archive.byteOffset,
      archive.byteOffset + archive.byteLength,
    ) as ArrayBuffer;
    form.append(
      "file",
      new Blob([bytes], { type: "application/zip" }),
      filename,
    );
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.#apiToken) headers.Authorization = `Bearer ${this.#apiToken}`;
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/document-transfer?on_conflict=${onConflict}`;
    const response = await this.#fetch(`${this.#apiUrl}${path}`, {
      method: "POST",
      redirect: "error",
      headers,
      body: form,
      signal,
    });
    return parseResponse<Record<string, unknown>>(response, "POST", path);
  }

  async triggerConsolidation(
    bankId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#request(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/consolidate`,
      {},
      signal,
    );
  }

  async knowledgeTree(
    bankId: string,
    signal?: AbortSignal,
  ): Promise<KnowledgeTreeResponse> {
    const response = await this.#request<Record<string, unknown>>(
      "GET",
      `/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/tree`,
      undefined,
      signal,
    );
    return {
      roots: Array.isArray(response.roots)
        ? (response.roots as KnowledgeNode[])
        : [],
    };
  }

  async createKnowledgeFolder(
    bankId: string,
    request: { name: string; parent_id?: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#request(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/folders`,
      request,
      signal,
    );
  }

  async createKnowledgePage(
    bankId: string,
    request: KnowledgePageRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#request(
      "POST",
      `/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/pages`,
      request,
      signal,
    );
  }

  async deleteKnowledgeNode(
    bankId: string,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#request(
      "DELETE",
      `/v1/default/banks/${encodeURIComponent(bankId)}/knowledge-base/nodes/${encodeURIComponent(nodeId)}`,
      undefined,
      signal,
    );
  }

  async updateMemory(
    bankId: string,
    memoryId: string,
    request: UpdateMemoryRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.#request(
      "PATCH",
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/${encodeURIComponent(memoryId)}`,
      request,
      signal,
    );
  }

  async #request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.#apiToken) headers.Authorization = `Bearer ${this.#apiToken}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.#fetch(`${this.#apiUrl}${path}`, {
      method,
      redirect: "error",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    return parseResponse<T>(response, method, path);
  }
}
