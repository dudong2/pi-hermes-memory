# Pi Hermes Memory Extension

## Project Overview

This is a Pi coding agent extension that brings Hermes-style persistent memory and a learning loop to any Pi user. After `pi install`, users get persistent memory across sessions, a background learning loop, and session-end flush.

Historical plans and task lists under `docs/` are references, not standing work instructions.

## Architecture

- **Language**: TypeScript (loaded via jiti, no compilation needed at runtime)
- **Runtime**: Pi extension API (`@earendil-works/pi-coding-agent`)
- **Storage**: Two markdown files (`MEMORY.md`, `USER.md`) in `~/.pi/agent/memory/`
- **Entry point**: `src/index.ts` — registers tools, event handlers, and commands

## Key Files

| File | Purpose |
|---|---
| `src/index.ts` | Extension entry point — wires all components together |
| `src/types.ts` | Shared TypeScript interfaces + `getMessageText()` helper |
| `src/constants.ts` | Prompts, defaults, delimiter |
| `src/store/memory-store.ts` | Core `MemoryStore` class — CRUD, persistence, frozen snapshot |
| `src/store/content-scanner.ts` | `scanContent()` — injection/exfiltration detection |
| `src/tools/memory-tool.ts` | `registerMemoryTool()` — LLM tool definition |
| `src/handlers/background-review.ts` | `setupBackgroundReview()` — learning loop via `pi.exec` |
| `src/handlers/session-flush.ts` | `setupSessionFlush()` — pre-compaction/shutdown flush |
| `src/handlers/insights.ts` | `registerInsightsCommand()` — `/memory-insights` command |
| `PLAN.md` | Full v0.1 implementation plan with Hermes source file reference map |
| `docs/ROADMAP.md` | Full roadmap with Hermes competitive analysis + gap analysis |
| `docs/0.2/TASKS.md` | v0.2 task breakdown — Skills + Smart Curation |

## Design Decisions

1. **Frozen snapshot** — Memory is injected into system prompt once at session start, never mutated mid-session (preserves Pi's prompt caching)
2. **Atomic writes** — Temp file + `fs.rename()` for crash safety
3. **`pi.exec()` for background review** — Stays within Pi's intended extension API
4. **`§` delimiter** — Same as Hermes for consistency
5. **No SQLite** — Pi has its own `SessionManager`, we read from it directly

## Hermes Source Reference

The implementation is ported from the Hermes agent harness. See `PLAN.md` → "Hermes Source File Reference Map" for exact files and line ranges to read.

## Documentation

- Do not use `docs/` as a log of work performed. Do not create or update plans, task trackers, investigation reports, test summaries, or release notes for routine work; report results in the reply instead.
- Do not update `docs/0.2/TASKS.md` as part of the default workflow. Existing roadmap and task documents are historical references; read them only when relevant to the requested task.
- Write repository documentation when the user explicitly requests it. If a change cannot be used safely without documentation, ask before adding it. A future repository-specific instruction may explicitly require shared documentation for team workflows.

## Development

```bash
# Type check
npm run check

# Test locally
pi -e ./src/index.ts
```

## Installation (for users)

```bash
pi install npm:pi-hermes-memory

# or from git
pi install git:github.com/chandra447/pi-hermes-memory
```
