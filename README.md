# PromptTrace

PromptTrace is a local-first VS Code/Cursor extension for reviewing the file changes made during each AI-agent prompt. The project is currently at its extension-foundation stage; file history and prompt attribution are planned but not implemented yet.

## Development

Requirements: Node.js 22.13 or newer (or Node.js 24+) and npm.

```powershell
npm install
npm run check
```

Press `F5` in VS Code or Cursor and choose **Run PromptTrace Extension** to launch an Extension Development Host. In that host, open the Command Palette and run **PromptTrace: Run Smoke Test**.

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

No history is captured during Phase 0.
