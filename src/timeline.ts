import * as vscode from "vscode";

import { Change, FileChange, HistoryIndex, Revision, SnapshotStore } from "./history";
import { filterHistoryIndex } from "./historyScope";
import { WorkspaceScope } from "./scope";
import { resolveStoredWorkspacePath } from "./workspacePath";

export const SNAPSHOT_SCHEME = "plan-tracker-snapshot";
export const COMPARE_PREVIOUS_COMMAND = "planTracker.compareWithPrevious";
export const COMPARE_CURRENT_COMMAND = "planTracker.compareWithCurrent";

type HistoryNode = FileNode | RevisionNode | ChangeNode | ChangeFileNode;

interface FileNode {
  type: "file";
  relativePath: string;
}

interface RevisionNode {
  type: "revision";
  revision: Revision;
}

interface ChangeNode {
  type: "change";
  change: Change;
}

interface ChangeFileNode {
  type: "changeFile";
  change: Change;
  file: FileChange;
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<HistoryNode | undefined>();
  private readonly storeSubscription: { dispose(): void };
  private readonly scopeSubscription: { dispose(): void };
  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(
    private readonly store: SnapshotStore,
    private readonly scopeMatcher: WorkspaceScope,
  ) {
    this.storeSubscription = store.onDidChange(() => this.changed.fire(undefined));
    this.scopeSubscription = scopeMatcher.onDidChange(() => this.changed.fire(undefined));
  }

  public dispose(): void {
    this.storeSubscription.dispose();
    this.scopeSubscription.dispose();
    this.changed.dispose();
  }

  public getTreeItem(element: HistoryNode): vscode.TreeItem {
    if (element.type === "change") {
      const item = new vscode.TreeItem(
        `Claude Code Â· ${formatTime(element.change.startedAt)}`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = element.change.id;
      item.description = `${element.change.attribution} Â· ${element.change.status}`;
      item.contextValue = "planTrackerChange";
      item.iconPath = new vscode.ThemeIcon(element.change.status === "completed" ? "sparkle" : "warning");
      item.tooltip = `${element.change.files.length} file(s)\nAttribution: ${element.change.attribution}\nStatus: ${element.change.status}`;
      return item;
    }

    if (element.type === "changeFile") {
      const revision = revisionForFileChange(element.change, element.file);
      const item = new vscode.TreeItem(displayPath(element.file.relativePath), vscode.TreeItemCollapsibleState.None);
      item.id = revision.id;
      item.description = workspaceName(element.file.relativePath);
      item.contextValue = "planTrackerRevision";
      item.iconPath = new vscode.ThemeIcon("diff");
      item.command = { command: COMPARE_PREVIOUS_COMMAND, title: "Open prompt diff", arguments: [revision] };
      return item;
    }

    if (element.type === "file") {
      const item = new vscode.TreeItem(
        displayPath(element.relativePath),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = workspaceName(element.relativePath);
      item.contextValue = "planTrackerFile";
      item.iconPath = new vscode.ThemeIcon("markdown");
      item.tooltip = element.relativePath;
      return item;
    }

    const revision = element.revision;
    const item = new vscode.TreeItem(
      formatTime(revision.recordedAt),
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = revision.id;
    item.description = `unassigned â€¢ ${revision.kind}`;
    item.contextValue = "planTrackerRevision";
    item.iconPath = new vscode.ThemeIcon(revision.kind === "deleted" ? "trash" : "history");
    item.tooltip = `${revision.relativePath}\n${new Date(revision.recordedAt).toLocaleString()}\nAttribution: unassigned\nKind: ${revision.kind}`;
    item.command = {
      command: COMPARE_PREVIOUS_COMMAND,
      title: "Compare with Previous Revision",
      arguments: [revision],
    };
    return item;
  }

  public getChildren(element?: HistoryNode): HistoryNode[] {
    const index = filterHistoryIndex(this.store.getIndex(), (path) => this.scopeMatcher.includesStoredPath(path));
    if (element === undefined) {
      const changes: ChangeNode[] = [...index.changes].reverse().map((change) => ({ type: "change", change }));
      const files: FileNode[] = pathsWithUnassignedRevisions(index)
        .map((relativePath) => ({ type: "file", relativePath }));
      return [...changes, ...files];
    }
    if (element.type === "file") {
      return [...index.revisions
        .filter((revision) => revision.relativePath === element.relativePath && revision.changeId === undefined)]
        .reverse()
        .map((revision) => ({ type: "revision", revision }));
    }
    if (element.type === "change") {
      return element.change.files.map((file) => ({ type: "changeFile", change: element.change, file }));
    }
    return [];
  }
}

export class SnapshotDocumentProvider implements vscode.TextDocumentContentProvider {
  public constructor(private readonly store: SnapshotStore) {}

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const snapshotId = snapshotIdFromUri(uri);
    if (snapshotId === undefined) {
      return "";
    }
    try {
      return await this.store.readSnapshot(snapshotId);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Plan Tracker could not read snapshot ${snapshotId}: ${message}`, { cause: error });
    }
  }
}

export function registerTimeline(context: vscode.ExtensionContext, store: SnapshotStore, scopeMatcher: WorkspaceScope): void {
  const tree = new HistoryTreeProvider(store, scopeMatcher);
  const documents = new SnapshotDocumentProvider(store);
  context.subscriptions.push(
    tree,
    vscode.window.registerTreeDataProvider("planTracker.history", tree),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, documents),
    vscode.commands.registerCommand(COMPARE_PREVIOUS_COMMAND, async (input: unknown) => {
      const revision = resolveRevision(input, store.getIndex());
      if (revision === undefined) {
        await vscode.window.showErrorMessage("Plan Tracker could not find that revision. Refresh the History view and try again.");
        return;
      }
      const before = snapshotUri(revision.previousSnapshotId, revision.relativePath, "previous");
      const after = snapshotUri(revision.snapshotId, revision.relativePath, revision.kind);
      await vscode.commands.executeCommand(
        "vscode.diff",
        before,
        after,
        `${displayPath(revision.relativePath)} (${revision.kind} â†” previous)`,
      );
    }),
    vscode.commands.registerCommand(COMPARE_CURRENT_COMMAND, async (input: unknown) => {
      const revision = resolveRevision(input, store.getIndex());
      if (revision === undefined) {
        await vscode.window.showErrorMessage("Plan Tracker could not find that revision. Refresh the History view and try again.");
        return;
      }
      const current = resolveStoredWorkspacePath(revision.relativePath);
      if (current === undefined) {
        await vscode.window.showErrorMessage(`Plan Tracker cannot compare ${displayPath(revision.relativePath)} because its workspace folder is not open.`);
        return;
      }
      try {
        await vscode.workspace.fs.stat(current);
      } catch {
        await vscode.window.showErrorMessage(`Plan Tracker cannot compare ${displayPath(revision.relativePath)} because the current file does not exist.`);
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.diff",
        snapshotUri(revision.snapshotId, revision.relativePath, revision.kind),
        current,
        `${displayPath(revision.relativePath)} (${revision.kind} â†” current)`,
      );
    }),
  );
}

function resolveRevision(input: unknown, index: Readonly<HistoryIndex>): Revision | undefined {
  if (typeof input === "string") {
    return index.revisions.find((revision) => revision.id === input);
  }
  if (typeof input === "object" && input !== null) {
    if ("type" in input && input.type === "revision" && "revision" in input) {
      return input.revision as Revision;
    }
    if ("relativePath" in input && typeof input.relativePath === "string"
      && "recordedAt" in input && typeof input.recordedAt === "string") {
      return input as unknown as Revision;
    }
    if ("id" in input && typeof input.id === "string") {
      return index.revisions.find((revision) => revision.id === input.id);
    }
  }
  return undefined;
}

export function snapshotUri(snapshotId: string | undefined, relativePath: string, label: string): vscode.Uri {
  const query = new URLSearchParams({ path: relativePath, label }).toString();
  return vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${snapshotId ?? "empty"}.md`, query });
}

function snapshotIdFromUri(uri: vscode.Uri): string | undefined {
  const name = uri.path.split("/").at(-1);
  if (name === undefined || name === "empty.md") {
    return undefined;
  }
  const snapshotId = name.endsWith(".md") ? name.slice(0, -3) : name;
  return /^[a-f\d]{64}$/u.test(snapshotId) ? snapshotId : undefined;
}

function pathsWithUnassignedRevisions(
  index: Readonly<HistoryIndex>,
): string[] {
  return [...new Set(index.revisions
    .filter((revision) => revision.changeId === undefined)
    .map((revision) => revision.relativePath))]
    .sort((left, right) => left.localeCompare(right));
}

function revisionForFileChange(change: Change, file: FileChange): Revision {
  return {
    id: `${change.id}:${file.relativePath}`,
    relativePath: file.relativePath,
    previousSnapshotId: file.beforeSnapshotId,
    snapshotId: file.afterSnapshotId,
    recordedAt: change.endedAt ?? change.startedAt,
    kind: file.afterSnapshotId === undefined ? "deleted" : file.beforeSnapshotId === undefined ? "created" : "edited",
    changeId: change.id,
  };
}

function displayPath(storedPath: string): string {
  const separator = storedPath.indexOf("/");
  return separator < 0 ? storedPath : storedPath.slice(separator + 1);
}

function workspaceName(storedPath: string): string {
  const separator = storedPath.indexOf("/");
  return separator < 0 ? "" : storedPath.slice(0, separator);
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
