---
pi-hermes-generation: 78892e37-63be-46c8-b7ed-411e314c9a07
name: "manage-memory-projects-and-scopes"
description: "Move and merge Pi memory Projects and Scopes without data loss."
version: 1
created: "2026-10-02"
updated: "2026-10-02"
---

# Manage Memory Projects and Scopes

## When to Use

Use when the user asks to move a Scope to another Project, move a Project's
member Scopes, merge Scope memories, or retire merged source sessions in this
Pi/Hermes/Hindsight setup. This is an agent-run operational procedure, not
permission to migrate data merely because the skill was read. Search-only access
does not require reassignment. Use Pi only; do not involve OMP compatibility,
process checks, shutdowns, or instructions.

## Procedure

1. Classify the request before touching data. Scope reassignment changes Project
   ownership but retains Scope ID, memory tag, local store and sessions.
   Project-wide reassignment moves member Scopes separately without mixing their
   memories. Scope merging moves all source memory into an existing destination
   identity and retires the sources. For a Project merge, explicitly determine
   whether its member Scopes remain separate or which Scope pairs actually
   merge; never infer memory mixing from a Project move.
2. Resolve exact Project/Scope IDs through the current catalog and existing
   resolver. Record source/destination tags, repository roots and markers,
   Scope-ID and legacy local-store locations, relevant SQLite mirror identities,
   Knowledge nodes, counts, skill/asset hashes and session ownership. Preserve
   an existing destination's identity; never bind different Git repositories to
   its marker merely to make selectors work.
3. Reuse existing capabilities. For one Scope's reassignment, read the existing
   reassign-memory-scope skill and use /memory-reassign-scope; for a batch,
   apply that same verified path per Scope and verify each result before the
   next. Do not create /memory-manage, a new service, a generic workflow engine
   or another backend. Locate the installed commands and current source rather
   than assuming legacy Orchestrator code owns them.
4. For a merge, read the completed receipt and helpers in
   ~/.config/pi-memory-orchestrator/backups/hermes-scope-merge-final-20261002T105620Z/.
   Reuse the verified functions
   migrate_database/rewrite_tags/rewrite_references, planLocal/localMerge,
   captureSessions/cleanupSessions, and
   drainWithBackoff/existingOperationAwareClient as needed. Inspect their bodies
   and input contracts first. This directory is a historical reference, not a
   runnable plan for new targets: do not rerun run_merge.py, its old plan, old
   receipts, or its hard-coded PID allowance. Use a small operation-local
   invocation of the existing helpers only after adapting and validating the
   actual targets; do not copy them into a new repository implementation.
5. Preview and confirm the exact source/destination identities, memory/skill
   treatment, whether retired-source session cleanup is included, and any
   Hindsight interruption. Check active Pi writers, cached source sessions and
   the durable outbox. Protect the current destination only when its cwd/marker
   identity and mutation locks genuinely support it; never copy a historical
   live-PID exception. Drain queued writes with bounded backoff and check
   existing operation status rather than blindly resubmitting a deferred retain.
   If safety cannot be established, stop before mutation.
6. Before destructive work, create a fresh private backup directory and verify
   the official Hindsight DB snapshot, affected catalog/markers, local MEMORY.md
   and failure attribution, skill directories including assets, SQLite online
   backup, Knowledge contents/links and selected session-log/index manifest. Do
   not persist credentials. Protect memory-routing settings only; unrelated
   model, theme or other settings must not block the operation.
   Preservation/deletion rehearsals use temporary stores, never real user
   skills.
7. For a lossless merge, use the verified local administrative routing
   transaction when normal Hindsight tag/export/import operations would
   invalidate or regenerate memories. Preserve document/memory/observation IDs,
   content, embeddings, timestamps, invalidation state, observation/source
   references and Knowledge page content. Rewrite routing identities only,
   checking preserved-field hashes and unrelated rows. Validate current schema
   and Knowledge parents, including cross-Project placement; unsupported
   remote/admin environments or unmatched invariants must stop before writes.
   Restore any paused service in failure paths and confirm health.
8. Merge local memory entries without losing either source or existing
   destination entries. Copy complete skill directories and assets, verifying
   byte hashes; resolve name collisions without overwriting or silently
   excluding a source skill. Use existing store/catalog APIs and metadata
   initialization. Move only affected SQLite memory mirror identities while
   preserving row IDs, contents and failure attribution. Verify the installed Pi
   runtime loads the merged local memory and skills, not just that files exist.
9. Only after remote and local preservation checks pass, retire merged source
   catalog entries, old markers and active source stores. Remove a source
   Project only when it is genuinely empty. For an authorized retiring-source
   cleanup, archive precisely the captured JSONL directories in the recovery
   backup and delete only their selected sessions/messages/session_files rows
   with the verified transaction, survivor fingerprints and FTS checks. Never
   delete shared sessions.db, destination/unrelated rows, repositories or
   recovery backups. Pure reassignment preserves sessions unless their deletion
   is separately requested.
10. Report completion only after all verification checks pass. On timeout or
    partial failure, inspect operation IDs, receipts and committed state before
    any retry; keep recovery data and report the incomplete phase honestly. Do
    not label partial work completed or blindly replay a migration. State any
    untested environment or protection gap. Release/tag/install work and Curator
    automatic-removal activation remain separate unless explicitly requested.

## Pitfalls

- The older global merge-scoped-memory-without-loss procedure and Orchestrator
  export/import script are not sufficient for strict ID preservation:
  regeneration can omit source observations, and they do not cover complete
  local-memory/skill/session migration. Follow the current preservation checks
  here instead of treating their old merge recommendation as safe.
- Never infer success from source tag counts alone; local stores, skills/assets,
  SQLite mirrors, Knowledge/source links and runtime loading require independent
  checks.
- A live retired-source session can recreate deleted memory or logs from cached
  state. Do not count an unobserved writer as safely idle or request unnecessary
  shutdowns of unrelated Pi sessions.
- Project ownership changes are not identity changes. Project-wide moves must
  not automatically concatenate Scope memories or silently resolve duplicate
  Scope names.
- Historical backups and completed plans are recovery/provenance data. Preserve
  them, do not execute them unchanged, and do not hard-code their IDs, counts,
  paths or PID into new operations.
- Do not add new product code merely to make this operational procedure
  reusable. Prefer existing commands and verified helper invocations; request a
  separate implementation decision only if a genuinely missing capability cannot
  be safely handled.

## Verification

1. For reassignment, catalog, marker, Hermes store metadata and Knowledge
   placement agree on the new Project; original Scope ID, tag, memory
   content/counts, skills and sessions remain unchanged.
2. For merging, every source document/memory/observation ID and protected-field
   hash is represented at the destination; source routing tags have no active
   documents/memories. Knowledge page bodies, links and IDs are preserved with
   correct destination parents.
3. All source and pre-existing destination local memory entries remain
   represented; each source skill and asset matches its recorded hash. Installed
   ProjectScopeBinding/MemoryStore/SkillStore loading confirms the destination
   state.
4. Affected SQLite memory IDs/content and failure attribution are preserved
   under destination identities; old mirror identities have no active rows.
   SQLite quick_check returns ok, foreign_key_check is empty, and message FTS
   integrity passes.
5. Authorized retired-source cleanup leaves no selected
   sessions/messages/session_files rows or active source JSONL directories;
   unrelated data fingerprints are unchanged and archived source logs/recovery
   backups remain intact. Shared sessions.db still exists.
6. Retired selectors no longer resolve as active Scopes; destination selectors
   resolve correctly; only empty source Projects disappear. Any paused Hindsight
   service is healthy and remaining outbox work has a known state.
7. The operation receipt records completed only after all phases succeed;
   otherwise it clearly records failure/partial application and enough
   checkpoint information to avoid blind replay.
