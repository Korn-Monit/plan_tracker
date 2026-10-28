# PromptTrace Project Plan

> Status: Draft baseline for implementation  
> Last updated: 2026-10-28  
> Source context: [`prompt_tracking_conversation.md`](prompt_tracking_conversation.md)

## 1. Product goal

Build a local-first VS Code/Cursor extension that lets a user see what an AI coding agent changed during each prompt without creating Git commits.

The first useful experience is:

1. A user starts an agent prompt.
2. The agent edits one or more Markdown files, possibly several times.
3. PromptTrace records the prompt as one **Change**, with the file state before and after it.
4. The user opens a timeline, selects that Change, and sees its net diff.
5. The user can compare versions or restore an earlier version.

The system should remain useful when prompt attribution is unavailable: it should still retain file history and label revisions as unassigned changes.

## 2. Decision ledger

This section is the source of truth for decisions. Change a locked decision only through the process in [Changing a locked decision](#changing-a-locked-decision).

### Locked for the MVP

| ID | Decision | Reason |
|---|---|---|
| D-001 | Build a native VS Code/Cursor extension in TypeScript. | It provides direct access to editor, filesystem, Tree View, commands, and diff APIs and avoids shipping a second runtime. |
| D-002 | Keep all history local to the workspace. | Plans and source code may be sensitive; local-first behavior also keeps the MVP simple and works offline. |
| D-003 | Do not require Git or Git commits. | Avoiding commits for temporary prompt checkpoints is the core product need. |
| D-004 | Separate revision capture from prompt attribution. | File history must continue working even when an agent integration is missing or fails. |
| D-005 | One completed prompt is exactly one user-visible **Change**. Its diff is the net result from immediately before the prompt to immediately after it. Intermediate saves are not separate Changes. | Agents can write the same file many times during one prompt, but the user wants to review the prompt as one operation. |
| D-006 | Start with Markdown files. | This is the primary use case and keeps early validation focused. The storage model must not prevent adding other text files later. |
| D-007 | Use full snapshots for the first implementation. | They make comparison and restore reliable. Optimization can follow real measurements. |
| D-008 | Use VS Code's native side-by-side diff for the MVP. | It is familiar, accessible, and substantially reduces UI work. |
| D-009 | Treat an unattributed change as valid history, not an error. | Watchers cannot always determine which prompt or agent caused a change. |
| D-010 | Never overwrite a user's file during restore without confirmation and one final safety snapshot. | Restore is destructive unless the current content is recoverable. |
| D-011 | Support one workspace window and one active prompt session in the first end-to-end version. | Correct concurrent attribution needs an explicit design and should not be guessed in the MVP. |
| D-012 | Do not depend on a cloud service, account, or telemetry for core behavior. | None is required to solve the stated problem. |
| D-013 | Store workspace history under the extension's workspace-scoped `storageUri`. | It keeps private history local and out of the user's repository while preserving it across editor restarts. |
| D-014 | Use Claude Code `UserPromptSubmit` as the prompt start boundary, `Stop` as the completed-turn boundary, and `SessionEnd` only to interrupt an unfinished turn. | These are the documented per-turn and per-session hook semantics; treating `SessionEnd` as a normal turn end would merge prompts. |
| D-015 | Store no Claude Code prompt text by default. | Attribution only needs provider, session, and timestamps; omitting prompt content minimizes sensitive metadata. |

### Open decisions

These are deliberately deferred until the relevant phase supplies evidence.

| ID | Question | Decide by | Current leaning |
|---|---|---|---|
| O-004 | How should overlapping agent turns be attributed? | After MVP | Mark ambiguous revisions instead of guessing. |
| O-005 | When should storage move from JSON/files to SQLite? | After Phase 5 measurements | Only when scale or querying demonstrates a need. |
| O-006 | Should the first release include rendered Markdown comparison? | After native diff usability testing | Native text diff first. |
| O-007 | What additional file types should be enabled by default? | After Markdown MVP feedback | User-configurable text globs. |

### Explicitly not decided

- Product name and marketplace branding; **PromptTrace** is a working name.
- Pricing, licensing, sync, teams, and hosted services.
- Support order after Claude Code (Codex, Cursor Agent, OpenCode, or others).
- Line-level authorship/provenance. A prompt diff is not proof that every surviving line originated in that prompt.

## 3. MVP scope

### Must have

- Watch Markdown documents in the active workspace.
- Persist timestamped, content-addressed snapshots across editor restarts.
- Avoid duplicate snapshots when content has not changed.
- Represent one known prompt as one Change, regardless of how many times the agent saves during that prompt.
- Let the user open the Change and see its before/after diff for the edited Markdown file.
- If a prompt edits multiple files, keep one Change with one file diff per edited file.
- Retain unassigned revisions when no prompt boundary is known.
- Show history by file and prompt/time in a Tree View.
- Open a native side-by-side diff between revisions.
- Restore a selected revision safely.
- Exclude PromptTrace's own storage and common generated/vendor directories.
- Work in both VS Code and Cursor to the extent supported by the VS Code extension API.

### Not in the MVP

- Semantic or section-level Markdown diffs.
- Line blame across many prompts.
- Multi-user history or cloud sync.
- Arbitrary binary-file versioning.
- Git replacement features such as branches, merges, or remote repositories.
- Perfect attribution when multiple agent sessions overlap.
- A custom diff renderer.

## 4. Architecture baseline

```text
Editor saves / filesystem changes          Agent lifecycle event
                 |                                  |
                 v                                  v
          Revision Capture                   Agent Adapter
                 |                                  |
                 +----------> Session Coordinator <-+
                                      |
                                      v
                               Snapshot Store
                                      |
                      +---------------+---------------+
                      v                               v
                History Tree                     Diff/Restore
```

### Component boundaries

| Component | Responsibility |
|---|---|
| `RevisionCapture` | Observe relevant document changes, debounce noisy writes, normalize paths, and provide file content to the coordinator. |
| `SessionCoordinator` | Track whether a prompt is active, preserve its baseline, collect touched files, and finalize exactly one Change. |
| `AgentAdapter` | Convert provider-specific lifecycle data into provider-neutral `turnStarted` and `turnEnded` events. |
| `SnapshotStore` | Persist immutable content plus revision/session metadata; deduplicate content by hash. |
| `HistoryTree` | Present files, sessions, timestamps, attribution state, and available actions. |
| `DiffProvider` | Expose stored snapshots as read-only virtual documents so `vscode.diff` can compare them. |
| `RestoreService` | Create a safety snapshot, request confirmation, and write the selected content. |

### Initial domain model

```ts
type AttributionState = "attributed" | "unassigned" | "ambiguous";

interface Snapshot {
  id: string;          // content hash
  content: string;
  byteLength: number;
  createdAt: string;
}

interface FileChange {
  id: string;
  relativePath: string;
  beforeSnapshotId?: string;
  afterSnapshotId: string;
}

interface Change {
  id: string;
  provider: "claude-code" | "unknown";
  externalSessionId?: string;
  startedAt: string;
  endedAt?: string;
  promptPreview?: string;
  files: FileChange[];
  attribution: AttributionState;
  status: "active" | "completed" | "interrupted";
}
```

This is a planning model, not a frozen schema. Storage migration/versioning should begin as soon as a schema is persisted.

## 5. Delivery plan

Each phase should end in a working vertical slice. Do not start a later phase merely because code exists; satisfy the exit gate first.

### Phase 0 — Project foundation

**Objective:** Create a runnable extension skeleton and establish its quality gates.

Deliverables:

- TypeScript VS Code extension project.
- Debug launch configuration and packaging command.
- Unit-test and lint/type-check commands.
- Basic extension settings namespace.
- A short manual test checklist for VS Code and Cursor.

Exit gate:

- The extension activates in an Extension Development Host.
- A smoke-test command appears and runs.
- Type checking and tests pass from a clean checkout.

### Phase 1 — Durable Markdown history

**Objective:** Reliably retain file revisions without any agent integration.

Deliverables:

- Markdown scope and configurable include/exclude globs.
- Initial workspace scan to establish baselines without falsely presenting every file as a user edit.
- File/document change capture with debouncing and atomic-write tolerance.
- Content hashing and duplicate suppression.
- Durable snapshot/revision store with a schema version.
- Recovery behavior for extension restart and incomplete/corrupt records.

Important cases to test:

- New, edited, renamed, and deleted Markdown files.
- Rapid repeated saves and an agent writing a file several times.
- Empty files, Unicode, large Markdown files, and external filesystem edits.
- Excluded folders and PromptTrace's own data directory.

Exit gate:

- After editing a Markdown file several times and restarting the editor, every distinct saved state is recoverable in order with no self-generated loop.

### Phase 2 — Timeline and comparison

**Objective:** Make stored history understandable and useful inside the editor.

Deliverables:

- Activity Bar/Explorer history Tree View grouped by file.
- Change labels containing time and attribution state, with edited files nested beneath them.
- Read-only virtual document provider for snapshots.
- Commands to compare a revision with its predecessor and with the current file.
- Empty states and actionable error messages.

Exit gate:

- A user can select any stored revision and inspect the correct native side-by-side diff without opening storage files manually.

### Phase 3 — Claude Code prompt attribution

**Objective:** Represent each Claude Code prompt as one Change while preserving the fallback history.

Before implementation:

- Verify the current Claude Code hook/event contract from official documentation or observed payload fixtures.
- Decide the prompt-text privacy default (O-003).
- Save sanitized event fixtures for adapter tests; never commit real prompts or machine-specific paths.

Deliverables:

- Provider-neutral agent adapter interface.
- Claude Code adapter for prompt start/end events.
- Prompt session coordinator that captures per-file baselines and final states.
- Exactly one Change per completed prompt, containing one net before/after diff per touched file.
- Clear handling for interrupted, missing-end, and overlapping events.
- A visible `unassigned` or `ambiguous` label whenever causality is uncertain.

Exit gate:

- One Claude Code prompt that edits the same Markdown file multiple times appears as one Change with the correct pre-prompt-to-post-prompt diff.
- A manual edit outside a prompt remains visible and is not falsely attributed.

Implementation note: the boundary events and payload shapes were verified against the official [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) on 2026-10-28. Sanitized `UserPromptSubmit` and `Stop` fixtures are retained under `src/test/fixtures/`.

### Phase 4 — Safe restore

**Objective:** Let users recover an earlier document state without losing the current one.

Deliverables:

- Restore command with file, revision time, and consequence in the confirmation message.
- Automatic safety snapshot immediately before overwrite.
- Defined behavior for a dirty editor buffer, missing file, renamed file, and insufficient permissions.
- Success/failure notification with a way to inspect the resulting diff.

Exit gate:

- A restored file exactly matches the selected snapshot, and the immediately previous content can itself be restored.

### Phase 5 — Hardening and MVP release

**Objective:** Make the vertical slice safe and distributable.

Deliverables:

- Retention controls such as maximum age and/or storage size.
- Redaction/privacy documentation and a command to delete workspace history.
- Measured behavior for representative large files and long histories.
- Tests for migrations, malformed history, Windows paths, multi-root workspaces, and unavailable files.
- README with installation, limitations, data location, and troubleshooting.
- Packaged VSIX tested in current VS Code and Cursor versions.

Exit gate:

- The end-to-end acceptance scenarios below pass in both target editors.
- No known issue can silently lose the user's current file during normal capture, compare, or restore operations.

### Phase 6 — Post-MVP discovery

Consider only after the MVP is being used:

- Rendered or section-aware Markdown comparison.
- Filters and search by prompt, file, agent, or date.
- Export/import of history.
- Adapters for Codex, Cursor Agent, and OpenCode.
- Multi-session conflict attribution.
- Optional SQLite index if measurements justify it.
- Section/line provenance with explicit confidence rather than false certainty.

## 6. End-to-end acceptance scenarios

1. **Unattributed history:** Edit and save `plan.md` three times without an agent. Three distinct states remain available after restart and are marked unassigned.
2. **Single prompt, multiple writes:** During one prompt, an agent writes `plan.md` several times. The timeline shows exactly one Change and one net diff from the pre-prompt state to the final state.
3. **Multiple files:** One prompt changes two Markdown files. The timeline still shows one Change, with both files beneath it and a correct diff for each file.
4. **Manual edit after a prompt:** A later manual edit is preserved but is not attached to the completed prompt.
5. **Interrupted prompt:** If no clean end event arrives, changes remain recoverable and the session is visibly marked interrupted or unassigned.
6. **Restore:** Restore an older revision, then undo that restore using the automatically captured safety snapshot.
7. **Restart:** Close and reopen the editor between changes; ordering and comparisons remain correct.
8. **Privacy:** With prompt-text storage disabled, history contains no full prompt content while attribution and timestamps still work.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Watcher events do not map cleanly to a prompt. | Use explicit lifecycle adapters; represent uncertainty instead of inferring silently. |
| Agents produce many transient writes. | Debounce capture but preserve prompt baselines; show prompt-level net revisions. |
| Snapshot storage grows quickly. | Deduplicate by content hash, measure usage, and add configurable retention before release. |
| Restore overwrites newer work. | Confirm the action and capture a final safety snapshot before every restore. |
| Provider hooks change. | Isolate integrations behind adapters and test against versioned fixtures. |
| Sensitive prompts or code leak into metadata. | Keep data local, minimize metadata, default away from full prompt retention, and document deletion. |
| Multiple sessions edit the same file. | Limit MVP support and label ambiguous cases; design explicit concurrency rules post-MVP. |
| Extension records its own writes recursively. | Exclude storage paths and suppress known restore/capture operations. |

## 8. Development workflow

For each phase:

1. Confirm the phase's open decisions and write them into the decision ledger.
2. Define or update acceptance tests before implementing the feature.
3. Build the smallest vertical slice that reaches the exit gate.
4. Run automated tests and the relevant manual scenario in VS Code and, when UI-facing, Cursor.
5. Record discovered limitations and follow-ups without silently expanding the phase.
6. Mark the phase complete only when its exit gate passes.

### Phase status tracker

| Phase | Status | Started | Completed | Notes |
|---|---|---|---|---|
| 0. Project foundation | Complete | 2026-10-26 | 2026-10-28 | Automated gates, Extension Development Host smoke checks, and installed VSIX smoke check passed in VS Code. Cursor validation was deferred. |
| 1. Durable Markdown history | Complete | 2026-10-28 | 2026-10-28 | Automated gates and a two-process VS Code 1.144.0 integration test passed, covering restart persistence, scope exclusions, deduplication, empty/Unicode/large states, and create/rename/delete events. |
| 2. Timeline and comparison | Complete | 2026-10-28 | 2026-10-28 | VS Code 1.144.0 integration test passed for the file-grouped History view, persisted virtual snapshots, and native predecessor/current-file diffs. |
| 3. Claude Code attribution | Complete | 2026-10-28 | 2026-10-28 | VS Code 1.144.0 integration test passed: two writes in one Claude turn produced one net attributed Change, prompt text was omitted, and a later manual edit remained unassigned. |
| 4. Safe restore | Not started | — | — | — |
| 5. Hardening and release | Not started | — | — | — |
| 6. Post-MVP discovery | Deferred | — | — | Driven by MVP feedback. |

## 9. Changing a locked decision

When new evidence challenges a locked decision:

1. Add a short decision record under `docs/decisions/` describing the context, alternatives, consequences, and proposed replacement.
2. Update the decision ledger and any affected phase or acceptance scenario in the same change.
3. Note whether existing stored data needs a migration.

This keeps the plan authoritative without pretending early decisions can never evolve.

## 10. Immediate next action

Start Phase 4 by defining dirty-buffer and missing-file restore behavior before implementing overwrite and safety-snapshot commands.
