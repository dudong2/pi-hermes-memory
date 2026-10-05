#!/usr/bin/env node
// Read-only usage report for a fixed cohort. This manifest is NOT Curator's
// generation ledger and cannot confer removal authority on a skill.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

const agentRoot = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
const manifestPath = path.join(agentRoot, "pi-hermes-memory", "curator", "usage-cohort.json");
const sessionsRoot = path.join(agentRoot, "sessions");

function directories(dir) {
  try {
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => path.join(dir, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function cohort() {
  const roots = [{ dir: path.join(agentRoot, "pi-hermes-memory", "skills"), prefix: "global" }];
  for (const project of directories(path.join(agentRoot, "projects-memory"))) {
    roots.push({ dir: path.join(project, "skills"), prefix: `project:${path.basename(project)}` });
  }
  const skills = [];
  for (const { dir, prefix } of roots) {
    for (const skillDir of directories(dir)) {
      const file = path.join(skillDir, "SKILL.md");
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        skills.push({ id: `${prefix}:${path.basename(skillDir)}`, path: file });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return skills.sort((a, b) => a.path.localeCompare(b.path));
}

function initialize() {
  // Exclusive creation: a repeated invocation must not reset the observation window.
  const skills = cohort();
  const payload = JSON.stringify({ start: new Date().toISOString(), skills }, null, 2) + "\n";
  const fd = fs.openSync(manifestPath, "wx", 0o600);
  try { fs.writeFileSync(fd, payload); } finally { fs.closeSync(fd); }
  console.log(JSON.stringify({ initialized: true, skills: skills.length, noDeletionAuthority: true }));
}

function text(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((item) => item?.type === "text").map((item) => item.text ?? "").join("\n");
}

function resolved(value, cwd) {
  if (typeof value !== "string") return null;
  return path.resolve(value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : path.resolve(cwd, value));
}

function* sessionFiles() {
  const pending = [sessionsRoot];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield file;
    }
  }
}

async function report(since = null) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch { throw new Error("invalid usage cohort"); }
  if (!Number.isFinite(Date.parse(manifest?.start)) || !Array.isArray(manifest?.skills)) throw new Error("invalid usage cohort");
  const cutoff = since ?? manifest.start;
  if (!Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString() !== cutoff || cutoff < manifest.start) {
    throw new Error("invalid usage start");
  }
  const byPath = new Map(manifest.skills.map((skill) => [skill.path, skill]));
  const usage = new Map(manifest.skills.map((skill) => [skill.id, { id: skill.id, read: 0, view: 0, deliveryCandidate: 0, lastSeenAt: null }]));
  const seen = new Set();
  const credit = (skill, kind, key, stamp) => {
    if (!skill || !usage.has(skill.id) || seen.has(key)) return;
    seen.add(key);
    const row = usage.get(skill.id);
    row[kind]++;
    if (!row.lastSeenAt || stamp > row.lastSeenAt) row.lastSeenAt = stamp;
  };
  let files = 0;
  let unreadable = 0;
  let malformedLines = 0;
  let incompleteNestedCalls = 0;
  for (const file of sessionFiles()) {
    files++;
    let sessionId = file;
    let cwd = agentRoot;
    const pending = new Map();
    try {
      const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); }
        catch { if (line.trim()) malformedLines++; continue; }
        if (entry.type === "session") {
          if (typeof entry.id === "string") sessionId = entry.id;
          if (typeof entry.cwd === "string") cwd = entry.cwd;
          continue;
        }
        if (entry.type !== "message") continue;
        const message = entry.message;
        if (!message || typeof message !== "object") continue;
        if (message.role === "assistant" && Array.isArray(message.content)) {
          for (const call of message.content) {
            if (call?.type === "toolCall" && typeof call.id === "string" && ["read", "skill_manage"].includes(call.name)) pending.set(call.id, call);
          }
        }
        const stamp = Date.parse(entry.timestamp);
        if (!Number.isFinite(stamp) || stamp < Date.parse(cutoff)) continue;
        let skill = null;
        let kind = null;
        if (message.role === "toolResult" && message.isError === false) {
          const call = pending.get(message.toolCallId);
          pending.delete(message.toolCallId);
          if (call?.name === "read" && message.toolName === "read") {
            skill = byPath.get(resolved(call.arguments?.path, cwd));
            kind = "read";
          } else if (call?.name === "skill_manage" && call.arguments?.action === "view" && message.toolName === "skill_manage") {
            try {
              const result = JSON.parse(text(message));
              if (result.success === true && result.skillId === call.arguments.skill_id) {
                skill = byPath.get(resolved(result.path, cwd));
                if (skill?.id !== result.skillId) skill = null;
                kind = "view";
              }
            } catch { /* An unparseable result is not a confirmed use. */ }
          }
        } else if (message.role === "user") {
          const delivered = text(message);
          const match = /^<skill name="([a-z0-9-]+)" location="([^"]+)">\n/.exec(delivered);
          if (match && delivered.includes("\n</skill>")) {
            skill = byPath.get(resolved(match[2], cwd));
            if (skill && !skill.id.endsWith(`:${match[1]}`)) skill = null;
            kind = "deliveryCandidate";
          }
        }
        if (skill && kind) credit(skill, kind,
          `${sessionId}:${entry.id ?? entry.timestamp}:${message.toolCallId ?? kind}:${skill.id}`, entry.timestamp);
        // Pi records successful nested codemode calls in the parent tool result;
        // their child results are not separate transcript messages.
        const nested = message.role === "toolResult" ? message.nestedCalls : null;
        if (nested?.complete === false) incompleteNestedCalls++;
        if (!Array.isArray(nested?.calls)) continue;
        for (const call of nested.calls) {
          if (call?.status !== "ok" || !call.arguments || typeof call.id !== "string") continue;
          // A nested skill_manage tool may return success:false while its tool
          // status is "ok"; metadata alone cannot confirm a successful view.
          if (call.name !== "read") continue;
          const target = byPath.get(resolved(call.arguments.path, cwd));
          if (target) credit(target, "read", `${sessionId}:${entry.id}:${call.id}:${target.id}`, entry.timestamp);
        }
      }
    } catch { unreadable++; }
  }
  const rows = [...usage.values()].sort((a, b) => a.id.localeCompare(b.id));
  console.log(JSON.stringify({ start: manifest.start, since: cutoff, skillCount: rows.length,
    sessionFiles: files, unreadableFiles: unreadable,
    malformedLines, incompleteNestedCalls, partial: unreadable > 0 || malformedLines > 0 || incompleteNestedCalls > 0,
    observedSkills: rows.filter((row) => row.read || row.view).length,
    possibleDeliverySkills: rows.filter((row) => row.deliveryCandidate).length,
    coverage: "Pi session records only; /skill delivery may be pasted; unobserved use is unknown; no deletion authority", skills: rows }, null, 2));
}

const args = process.argv.slice(2);
if (!(args.length === 1 && args[0] === "--init")
  && !(args[0] === "--report" && (args.length === 1 || (args.length === 3 && args[1] === "--since")))) {
  console.error("Usage: node scripts/curator-usage.mjs --init | --report [--since <ISO timestamp>]");
  process.exitCode = 2;
} else {
  try { if (args[0] === "--init") initialize(); else await report(args[2] ?? null); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
