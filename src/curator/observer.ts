import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { canonicalStoragePath } from "../store/canonical-storage-path.js";
import { parseFrontmatter, parseSkillId } from "../store/skill-utils.js";
import { MAX_SKILL_BYTES, pathKey, readLimited, sameSnapshot, snapshotSkill } from "./files.js";
import type { ActivityKind, CuratorRecord, InventoryRoot, ObservationGapReason, SkillSnapshot } from "./model.js";
import type { CuratorStore } from "./store.js";

export interface ObserverToolCall {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}
export interface ObserverToolResult extends ObserverToolCall {
  isError: boolean;
  content: readonly { type: string; text?: string }[];
}
export interface ObserverInput {
  text: string;
  source?: string;
  streamingBehavior?: string;
}
export interface ObserverUserMessage {
  role: string;
  timestamp?: number;
  content: string | readonly { type: string; text?: string }[];
}

interface Target { record: CuratorRecord; snapshot: SkillSnapshot; root: string; filePath: string; }
interface Frame { target: Target; token: string; kind: ActivityKind; }
interface CommandFrame { name: string; frames: Frame[]; bodyHashes: Map<string, { hash: string; length: number }>; }
const LIMIT = 256;
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class CuratorObserver {
  private queue: Promise<void> = Promise.resolve();
  private running = false;
  private runId = "";
  private sessionKey = "";
  private persisted = false;
  private readonly pending = new Map<string, Frame>();
  private readonly completed = new Set<string>();
  private readonly commands: CommandFrame[] = [];
  private readonly delivered = new Set<string>();
  private readonly gaps = new Map<string, { reason: ObservationGapReason; generationId: string | null }>();

  constructor(private readonly store: CuratorStore, private readonly roots: () => InventoryRoot[]) {}

  private safe(operation: () => Promise<void> | void): Promise<void> {
    const task = this.queue.then(async () => {
      try { await operation(); } catch {
        // Hooks must not block or rewrite the original tool/input result on failure.
        this.store.noteFailure();
        try { this.gap("observer-error"); } catch { /* An open run remains unresolved if persistence fails. */ }
      }
    });
    this.queue = task;
    return task;
  }

  private ensureRun(): boolean {
    if (!this.running) return false;
    if (!this.persisted) {
      if (!this.store.list().some((row) => row.state === "active")) return false;
      this.store.beginObservation(this.runId, this.sessionKey);
      this.persisted = true;
      for (const gap of this.gaps.values()) this.store.recordGap(this.runId, gap.reason, gap.generationId);
    }
    return true;
  }

  private gap(reason: ObservationGapReason, generationId: string | null = null): void {
    this.gaps.set(`${reason}:${generationId ?? "all"}`, { reason, generationId });
    if (this.ensureRun()) this.store.recordGap(this.runId, reason, generationId);
  }

  private async finish(): Promise<void> {
    if (!this.running) return;
    try {
      if (this.pending.size || this.commands.length) this.gap("pending-at-session-end");
      if (this.persisted) this.store.endObservation(this.runId);
    } finally {
      this.running = false;
      this.pending.clear();
      this.commands.length = 0;
    }
  }

  start(sessionId: string): Promise<void> {
    return this.safe(async () => {
      try { await this.finish(); } catch { this.store.noteFailure(); }
      this.runId = randomUUID();
      this.sessionKey = digest(`curator-session:${sessionId}`);
      this.running = true;
      this.persisted = false;
      this.gaps.clear();
      this.completed.clear();
      this.delivered.clear();
      this.ensureRun();
    });
  }

  private async target(selector: { skillId?: string; filePath?: string }, cwd: string): Promise<Target | null> {
    const records = this.store.list().filter((row) => row.state === "active");
    if (!records.length) return null;
    let wanted: string | undefined;
    if (selector.filePath) {
      const expanded = selector.filePath.startsWith("~/") ? path.join(homedir(), selector.filePath.slice(2)) : selector.filePath;
      wanted = await canonicalStoragePath(path.resolve(cwd, expanded));
    }
    for (const record of records) {
      if (selector.skillId && record.skillId !== selector.skillId) continue;
      let root: string | undefined;
      if (record.rootRelativePath === "@configured") {
        for (const candidate of this.roots()) {
          if (candidate.scope === record.scope && pathKey(await canonicalStoragePath(candidate.path)) === record.rootKey) {
            root = candidate.path;
            break;
          }
        }
      } else {
        root = path.resolve(this.store.agentRoot, record.rootRelativePath);
        const relative = path.relative(this.store.agentRoot, root);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      }
      if (!root || pathKey(await canonicalStoragePath(root)) !== record.rootKey) continue;
      const filePath = path.resolve(root, record.relativePath);
      if (wanted && await canonicalStoragePath(filePath) !== wanted) continue;
      try {
        const snapshot = await snapshotSkill({ agentRoot: this.store.agentRoot, root, filePath, skillId: record.skillId, scope: record.scope });
        if (sameSnapshot(record, snapshot)) return { record, snapshot, root, filePath };
      } catch { /* Unverified files never become tracked through a read. */ }
    }
    return null;
  }

  private toolSelector(event: ObserverToolCall): { kind: "read" | "view"; selector: { skillId?: string; filePath?: string } } | null {
    if (event.toolName === "read" && typeof event.input.path === "string") return { kind: "read", selector: { filePath: event.input.path } };
    if (event.toolName === "skill_manage" && event.input.action === "view" && typeof event.input.skill_id === "string") {
      return { kind: "view", selector: { skillId: event.input.skill_id } };
    }
    return null;
  }

  onToolCall(event: ObserverToolCall, cwd: string): Promise<void> {
    return this.safe(async () => {
      if (!this.running) return;
      const selected = this.toolSelector(event);
      if (!selected) return;
      const target = await this.target(selected.selector, cwd);
      if (!target) return;
      if (this.pending.has(event.toolCallId)) {
        const existing = this.pending.get(event.toolCallId)!;
        if (existing.kind !== selected.kind || !sameSnapshot(existing.target.snapshot, target.snapshot)) {
          this.pending.delete(event.toolCallId);
          this.gap("ambiguous-tool-call", target.record.generationId);
        }
        return;
      }
      if (this.pending.size >= LIMIT) { this.gap("queue-overflow"); return; }
      this.ensureRun();
      this.completed.delete(event.toolCallId);
      this.pending.set(event.toolCallId, { target, token: randomUUID(), kind: selected.kind });
    });
  }

  private async credit(frame: Frame): Promise<void> {
    if (!this.ensureRun()) return;
    await this.store.withMutation([frame.target.root], async () => {
      const current = await this.target({ skillId: frame.target.record.skillId }, this.store.agentRoot);
      if (!current || !sameSnapshot(frame.target.snapshot, current.snapshot)) {
        this.gap("generation-changed", frame.target.record.generationId);
        return;
      }
      const eventKey = digest(`${this.sessionKey}:${this.runId}:${frame.token}:${frame.kind}:${current.record.generationId}`);
      if (!this.store.recordActivity(this.runId, eventKey, frame.kind, current.snapshot)) {
        this.gap("generation-changed", frame.target.record.generationId);
      }
    });
  }

  onToolResult(event: ObserverToolResult, cwd: string): Promise<void> {
    return this.safe(async () => {
      if (!this.running || this.completed.has(event.toolCallId)) return;
      const frame = this.pending.get(event.toolCallId);
      this.pending.delete(event.toolCallId);
      this.completed.add(event.toolCallId);
      if (this.completed.size > LIMIT * 4) this.completed.delete(this.completed.values().next().value!);
      if (event.isError === true) return;
      if (event.isError !== false) { this.gap("observer-error"); return; }
      const selected = this.toolSelector(event);
      if (!selected) return;
      const target = await this.target(selected.selector, cwd);
      if (!frame) {
        if (target) this.gap("unpaired-tool-result", target.record.generationId);
        return;
      }
      if (!target || frame.kind !== selected.kind || !sameSnapshot(frame.target.snapshot, target.snapshot)) {
        this.gap("generation-changed", frame.target.record.generationId);
        return;
      }
      if (selected.kind === "view") {
        const text = event.content.filter((item) => item.type === "text");
        if (text.length !== 1 || typeof text[0].text !== "string" || Buffer.byteLength(text[0].text) > 4 * 1024 * 1024) {
          this.gap("unpaired-tool-result", target.record.generationId); return;
        }
        let result: Record<string, unknown> | null;
        try { result = object(JSON.parse(text[0].text)); } catch { this.gap("unpaired-tool-result", target.record.generationId); return; }
        if (result?.success === false) return;
        if (result?.success !== true || result.skillId !== target.record.skillId || result.scope !== target.record.scope
          || typeof result.path !== "string" || await canonicalStoragePath(result.path) !== await canonicalStoragePath(target.filePath)) {
          this.gap("unpaired-tool-result", target.record.generationId); return;
        }
      }
      await this.credit(frame);
    });
  }

  onInput(event: ObserverInput, cwd: string): Promise<void> {
    return this.safe(async () => {
      if (!this.running) return;
      const match = /^\/skill:([a-z0-9-]+)(?:\s|$)/.exec(event.text);
      if (!match) return;
      if (this.commands.length >= LIMIT) { this.gap("queue-overflow"); return; }
      const frames: Frame[] = [];
      const bodyHashes = new Map<string, { hash: string; length: number }>();
      const loadedRoots = new Set(await Promise.all(this.roots().map(async (root) => pathKey(await canonicalStoragePath(root.path)))));
      for (const row of this.store.list()) {
        if (row.state !== "active" || !loadedRoots.has(row.rootKey) || parseSkillId(row.skillId)?.slug !== match[1]) continue;
        const target = await this.target({ skillId: row.skillId }, cwd);
        if (!target) continue;
        const body = parseFrontmatter((await readLimited(target.filePath, MAX_SKILL_BYTES)).toString("utf8")).body.trim();
        frames.push({ target, token: randomUUID(), kind: "skill-command" });
        bodyHashes.set(row.generationId, { hash: digest(body), length: body.length });
      }
      if (frames.length) {
        this.ensureRun();
        this.commands.push({ name: match[1], frames, bodyHashes });
      }
    });
  }

  onUserMessage(message: ObserverUserMessage): Promise<void> {
    return this.safe(async () => {
      if (!this.running || message.role !== "user") return;
      const text = typeof message.content === "string" ? message.content : message.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
      if (!text.startsWith("<skill ")) {
        const plain = /^\/skill:([a-z0-9-]+)(?:\s|$)/.exec(text);
        if (plain) {
          const index = this.commands.findIndex((command) => command.name === plain[1]);
          if (index >= 0) this.commands.splice(index, 1); // Failed expansion is not activity.
        }
        return;
      }
      const header = /^<skill name="([a-z0-9-]+)" location="([^"]+)">\n/.exec(text);
      if (!header) { this.gap("unconfirmed-skill-command"); return; }
      const target = await this.target({ filePath: header[2] }, this.store.agentRoot);
      if (!target) return; // External skills remain outside Curator.
      const key = digest(`${message.timestamp ?? "missing"}:${target.record.generationId}`);
      if (this.delivered.has(key)) {
        if (this.commands.some((command) => command.name === header[1])) this.gap("ambiguous-skill-command", target.record.generationId);
        return;
      }
      this.delivered.add(key);
      if (this.delivered.size > LIMIT * 4) this.delivered.delete(this.delivered.values().next().value!);
      const index = this.commands.findIndex((command) => command.name === header[1]
        && command.frames.some((frame) => frame.target.record.generationId === target.record.generationId));
      if (index < 0 || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) { this.gap("unconfirmed-skill-command", target.record.generationId); return; }
      const command = this.commands.splice(index, 1)[0];
      const frame = command.frames.find((item) => item.target.record.generationId === target.record.generationId)!;
      const expected = command.bodyHashes.get(target.record.generationId)!;
      const prefix = `${header[0]}References are relative to ${path.dirname(header[2])}.\n\n`;
      const body = text.slice(prefix.length, prefix.length + expected.length);
      const suffix = text.slice(prefix.length + expected.length);
      if (!text.startsWith(prefix) || digest(body) !== expected.hash || !suffix.startsWith("\n</skill>")
        || (suffix !== "\n</skill>" && !suffix.startsWith("\n</skill>\n\n"))) {
        this.gap("unconfirmed-skill-command", target.record.generationId); return;
      }
      await this.credit(frame);
    });
  }

  onNestedResult(metadata: unknown): Promise<void> {
    return this.safe(async () => {
      if (!this.running) return;
      const nested = object(metadata);
      if (!nested) return;
      if (nested.complete === false) this.gap("incomplete-nested-calls");
      if (!Array.isArray(nested.calls)) return;
      for (const raw of nested.calls) {
        const call = object(raw);
        if (!call || call.status === "failed") continue;
        const args = object(call.arguments);
        if (call.name !== "read" && !(call.name === "skill_manage" && args?.action === "view" && typeof args.skill_id === "string")) continue;
        const id = call.toolCallId ?? call.id;
        if (typeof id !== "string" || !this.completed.has(id)) this.gap("unobserved-nested-call");
      }
    });
  }

  close(): Promise<void> { return this.safe(() => this.finish()); }
}
