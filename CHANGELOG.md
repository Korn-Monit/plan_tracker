# Changelog

## 0.2.0

- Added per-workspace `.plantrackerignore` files with Gitignore-compatible rules and live reloads.
- Applied one Markdown scope consistently to capture, agent-attributed changes, and History.
- Preserved hidden history and prevented false revisions when excluded files are re-included.
- Fixed VSIX packaging so the Gitignore parser runtime dependency is included.

## 0.1.0

Initial public preview release.

- Capture durable Markdown revisions without creating Git commits.
- Browse workspace history and compare revisions with VS Code's native diff editor.
- Restore earlier content after creating a safety snapshot.
- Group revisions by supported coding-agent lifecycle events.
- Configure age and storage retention limits.
- Delete all Plan Tracker history for a workspace.
