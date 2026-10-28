# PromptTrace

PromptTrace is a local-first VS Code/Cursor extension for reviewing file history and, in a later phase, the changes made during each AI-agent prompt. Phase 1 captures durable Markdown revisions independently of any agent integration.

## Markdown history

When enabled, PromptTrace scans the open workspace and stores the initial contents of matching files as baselines. Later editor saves and filesystem create/change/delete/rename events produce ordered revisions. Content-identical events are ignored.

History lives in VS Code's workspace-scoped extension `storageUri`, outside the project, as a schema-versioned JSON index plus immutable SHA-256-addressed snapshot files. PromptTrace recovers from a malformed or incomplete primary index using its last complete backup. There is intentionally no history UI yet; timeline, comparison, and restore are Phase 2 and Phase 4 work.

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

`npm run test:vscode` uses VS Code's official Electron test harness to run capture and restart validation in two isolated VS Code processes.

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
