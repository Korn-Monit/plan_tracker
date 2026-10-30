# Plan Tracker

Plan Tracker is a local-first VS Code extension that keeps a recoverable history of Markdown files and lets you inspect changes with VS Code's native diff editor. It is designed to remain useful whether a change came from a person, an AI coding agent, or another tool.

> **Early version:** Plan Tracker is still under active development. Features, storage formats, commands, and configuration may change. Test restore workflows on non-critical files before relying on it as your only recovery mechanism.

Plan Tracker is currently focused on making local Markdown history simple, visible, and safe to explore.

## Features

- Captures distinct saved states of `.md` and `.markdown` files.
- Keeps history across editor restarts without creating Git commits.
- Shows revisions in a Plan Tracker Activity Bar view.
- Compares stored revisions with their predecessor or the current file.
- Restores older content after creating a safety snapshot of the current file.
- Deduplicates identical content and applies configurable retention limits.
- Stores history locally in VS Code's workspace storage.
- Can group changes by an agent turn when supported lifecycle events are supplied.

Plan Tracker complements version control; it is not a replacement for Git, backups, or source-control review.

## Example: review an agent's plan before execution

Imagine you are working with a coding agent such as Claude Code or Codex. You ask it to create or revise `PROJECT_PLAN.md`, but before allowing implementation to begin, you want to understand exactly how the plan changed.

With Plan Tracker you can:

1. Save the current plan as a known baseline.
2. Let the coding agent revise the Markdown file.
3. Open Plan Tracker and select the newest revision.
4. Review additions and removals in VS Code's diff editor.
5. Accept the revised plan, continue editing it, or restore the earlier version before any code is executed.

This workflow does not require agent attribution. Plan Tracker records saved Markdown changes made by Claude, Codex, another tool, or a person. When a supported lifecycle integration is available, related file revisions can additionally be grouped into one agent turn.

## Installation

1. Open the Command Palette with `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on macOS.
2. Run **Extensions: Install from VSIX...**.
3. Select the packaged Plan Tracker `.vsix` file.
4. Reload VS Code when prompted.

## Getting started

1. Open a folder or workspace in VS Code.
2. Create or edit a Markdown file and save it.
3. Open the **Plan Tracker** icon in the Activity Bar.
4. Select a revision to compare it with its previous state.
5. Use a revision's actions to compare it with the current file or restore it.

Plan Tracker records initial matching files as baselines. Content-identical saves do not create duplicate revisions.

### Restoring a revision

Choose **Restore Revision** from a revision's context menu. Plan Tracker shows the target and consequence before writing, refuses to overwrite a dirty editor, and records the current on-disk content as a safety snapshot first. Restoring a historical path recreates that path when it is missing; Plan Tracker does not guess renamed destinations.

### Deleting history

Run **Plan Tracker: Delete Workspace History** from the Command Palette. After confirmation, Plan Tracker permanently removes that workspace's stored revisions, snapshots, and backup indexes, then records current matching files as fresh baselines.

## Agent attribution

File history works without an agent integration and such revisions are shown as unassigned.

Plan Tracker currently contains experimental support for grouping revisions between Claude Code `UserPromptSubmit` and `Stop` lifecycle events. The extension does not yet provide a user-facing hook installer, so another integration must deliver those events to `planTracker.handleClaudeHook`. Prompt text is omitted by default.

## Configuration

The following settings are available under `planTracker`:

- `enabled`: enables capture for the editor window.
- `include`: workspace-relative file patterns to capture.
- `exclude`: patterns that must not be captured.
- `debounceMilliseconds`: coalesces noisy filesystem events.
- `maxAgeDays`: removes old history after the configured number of days; `0` disables age retention.
- `maxStorageMegabytes`: limits referenced snapshot storage; `0` disables size retention.

Current file heads and active agent-turn baselines are preserved even when they exceed a retention limit.

## Storage and privacy

History is stored outside the project in VS Code's workspace-scoped extension storage. It consists of a schema-versioned JSON index and content-addressed snapshot files. Plan Tracker attempts to recover a malformed primary index from its last complete backup.

Snapshot contents are stored verbatim and are not redacted. Paths, timestamps, provider/session identifiers, and attribution state may also be stored. Exclude sensitive files before editing them; adding an exclusion later does not erase existing history. Use the deletion command to remove previously captured data.

## Current limitations

- The project is an early version and has not received broad real-world testing.
- Markdown is the default supported content type; binary history is unsupported.
- Agent attribution requires an external lifecycle-event integration.
- Overlapping or incomplete agent turns may be marked ambiguous or interrupted.
- History is local to each VS Code workspace and is not synchronized.
- Retention cannot reduce storage below the size required by current file heads.
- Cursor may work through VS Code API compatibility, but VS Code is the only required validation target.

## Troubleshooting

- If history is empty, verify that a workspace is open, `planTracker.enabled` is enabled, and the include/exclude patterns match the file.
- If restore is refused, save or revert unsaved editor changes and try again.
- If a snapshot is unavailable, saving an unchanged current file can repair its current content-addressed snapshot; unavailable older content cannot be reconstructed.
- If backup recovery is reported, check available disk space and filesystem permissions.
- For activation or filesystem errors, run **Developer: Show Logs...** and inspect the Extension Host log.

## Development

Requirements: Node.js 22.13 or newer (or Node.js 24+) and npm.

```powershell
npm install
npm run check
npm run test:vscode
```

Press `F5` and choose **Run Plan Tracker Extension** to launch an Extension Development Host. Run **Plan Tracker: Run Smoke Test** from its Command Palette to verify activation.

Create an installable VSIX with:

```powershell
npm run package
```

## License

Plan Tracker is available under the [MIT License](LICENSE).
