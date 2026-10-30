# PromptTrace

PromptTrace is a local-first VS Code/Cursor extension for reviewing file history and the changes made during each Claude Code prompt. It captures durable Markdown revisions independently of attribution and exposes them in a native VS Code history and diff workflow.

## Markdown history

When enabled, PromptTrace scans the open workspace and stores the initial contents of matching files as baselines. Later editor saves and filesystem create/change/delete/rename events produce ordered revisions. Content-identical events are ignored.

History lives in VS Code's workspace-scoped extension `storageUri`, outside the project, as a schema-versioned JSON index plus immutable SHA-256-addressed snapshot files. PromptTrace recovers from a malformed or incomplete primary index using its last complete backup.

Open the PromptTrace Activity Bar view to browse prompt-level Changes and unassigned revisions grouped by file. Select a revision to compare it with its predecessor, or use its inline action to compare it with the current workspace file. Stored snapshots open through a read-only virtual-document provider in VS Code's native side-by-side diff editor.

Use **Restore Revision** from a revision's context menu to recover that content. PromptTrace shows the recorded path, revision time, and overwrite consequence before proceeding, captures the current on-disk content as a final safety snapshot, and offers a post-restore diff. It refuses to overwrite an editor with unsaved changes. A missing file (and missing parent folders) is recreated at its recorded historical path; PromptTrace never guesses that a differently named file is its renamed destination. Read or write permission failures leave the file unchanged where possible and retain any safety snapshot already captured.

Claude Code `UserPromptSubmit` and `Stop` hook payloads are normalized behind a provider-neutral adapter. All revisions between those boundaries are shown as one Change with a net before/after diff per file. Prompt text is not stored by default; manual edits remain `unassigned`, interrupted sessions remain recoverable, and overlapping turns are labeled `ambiguous`.

The settings are:

- `promptTrace.enabled`
- `promptTrace.include` (defaults to Markdown and `.markdown` files)
- `promptTrace.exclude` (defaults to Git, dependency, vendor, build, and PromptTrace data folders)
- `promptTrace.debounceMilliseconds` (filesystem-event coalescing; editor saves are captured immediately)

## Development

Requirements: Node.js 22.13 or newer (or Node.js 24+) and npm.

```powershell
npm install
npm run check
npm run test:vscode
```

Press `F5` in VS Code or Cursor and choose **Run PromptTrace Extension** to launch an Extension Development Host. In that host, open the Command Palette and run **PromptTrace: Run Smoke Test**.

`npm run test:vscode` uses VS Code's official Electron test harness to run capture, restart, timeline, Claude attribution, and safe-restore validation in isolated VS Code processes.

Create an installable VSIX with:

```powershell
npm run package
```

## Manual Phase 0 checklist

Run the following in both VS Code and Cursor:

- [ ] Open this repository and run `npm install` followed by `npm run check`.
- [ ] Press `F5`; confirm an Extension Development Host opens without an activation error.
- [ ] In the development host, run **PromptTrace: Run Smoke Test** from the Command Palette.
- [ ] Confirm the notification says **PromptTrace is active.**
- [ ] Set `promptTrace.enabled` to `false`, rerun the command, and confirm the disabled notification appears.
- [ ] Run `npm run package`, install the resulting `prompttrace.vsix`, and repeat the smoke command.

## Manual Phase 1 checklist

- [ ] Launch an Extension Development Host on a workspace containing an existing Markdown file; verify activation creates a baseline but no user-edit revision.
- [ ] Save distinct empty, Unicode, and large-file states, including several rapid saves.
- [ ] Create, rename, and delete Markdown files, and edit one outside the editor.
- [ ] Verify excluded folders do not appear in the history index.
- [ ] Reload the Extension Development Host, make another edit, and verify all distinct saved snapshots remain in order.
- [ ] Repeat the restart/capture scenario in Cursor before declaring cross-editor validation complete.

## Manual Phase 2 checklist

- [ ] Open the PromptTrace Activity Bar view and confirm tracked files and newest-first revision labels appear.
- [ ] Select baseline, edited, renamed, and deleted revisions and verify the native diff shows the correct before/after contents.
- [ ] Use **Compare with Current File** on an older revision and verify the right side is the current workspace file.
- [ ] Confirm stored snapshot editors are read-only and missing current files produce an actionable error.

## Manual Phase 3 checklist

- [ ] Send sanitized `UserPromptSubmit` and `Stop` payloads through `promptTrace.handleClaudeHook` around a Claude turn.
- [ ] Confirm repeated writes to one Markdown file appear as one completed Change with one net diff.
- [ ] Confirm a prompt touching multiple Markdown files has one file entry for each final net change.
- [ ] Make a manual edit after the turn and confirm it remains unassigned.
- [ ] End a session without `Stop` and confirm the active Change is visibly interrupted; overlap two starts and confirm ambiguity is visible.
- [ ] Inspect workspace storage and confirm full prompt text was not persisted.

## Manual Phase 4 checklist

- [ ] Restore an older revision and confirm the dialog names the file, revision time, and overwrite consequence.
- [ ] Choose **Compare Restore** after success and inspect the safety-snapshot-to-restored-file diff.
- [ ] Restore the safety revision and verify the pre-restore contents return exactly.
- [ ] Try restore with unsaved editor changes and verify PromptTrace refuses without changing the file.
- [ ] Rename or delete a tracked file, then restore its earlier revision and verify the historical path is recreated without changing the renamed file.
- [ ] Try restoring to a location without write permission and verify the failure is actionable and the safety snapshot remains available.
