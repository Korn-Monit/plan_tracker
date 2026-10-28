import * as vscode from "vscode";

import { HistoryIndex, Revision, SnapshotStore } from "./history";

export const SNAPSHOT_SCHEME = "prompttrace-snapshot";
export const COMPARE_PREVIOUS_COMMAND = "promptTrace.compareWithPrevious";
export const COMPARE_CURRENT_COMMAND = "promptTrace.compareWithCurrent";

type HistoryNode = FileNode | RevisionNode;

interface FileNode {
  type: "file";
  relativePath: string;
}

interface RevisionNode {
  type: "revision";
  revision: Revision;
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<HistoryNode | undefined>();
  private readonly storeSubscription: { dispose(): void };
  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(private readonly store: SnapshotStore) {
    this.storeSubscription = store.onDidChange(() => this.changed.fire(undefined));
  }

  public dispose(): void {
    this.storeSubscription.dispose();
    this.changed.dispose();
  }

  public getTreeItem(element: HistoryNode): vscode.TreeItem {
    if (element.type === "file") {
      const item = new vscode.TreeItem(
        displayPath(element.relativePath),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = workspaceName(element.relativePath);
      item.contextValue = "promptTraceFile";
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
    item.description = `unassigned • ${revision.kind}`;
    item.contextValue = "promptTraceRevision";
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
    const index = this.store.getIndex();
    if (element === undefined) {
      return pathsWithRevisions(index).map((relativePath) => ({ type: "file", relativePath }));
    }
    if (element.type === "file") {
      return [...index.revisions
        .filter((revision) => revision.relativePath === element.relativePath)]
        .reverse()
        .map((revision) => ({ type: "revision", revision }));
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
      throw new Error(`PromptTrace could not read snapshot ${snapshotId}: ${message}`);
    }
  }
}

export function registerTimeline(context: vscode.ExtensionContext, store: SnapshotStore): void {
  const tree = new HistoryTreeProvider(store);
  const documents = new SnapshotDocumentProvider(store);
  context.subscriptions.push(
    tree,
    vscode.window.registerTreeDataProvider("promptTrace.history", tree),
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, documents),
    vscode.commands.registerCommand(COMPARE_PREVIOUS_COMMAND, async (input: unknown) => {
      const revision = resolveRevision(input, store.getIndex());
      if (revision === undefined) {
        await vscode.window.showErrorMessage("PromptTrace could not find that revision. Refresh the History view and try again.");
        return;
      }
      const before = snapshotUri(revision.previousSnapshotId, revision.relativePath, "previous");
      const after = snapshotUri(revision.snapshotId, revision.relativePath, revision.kind);
      await vscode.commands.executeCommand(
        "vscode.diff",
        before,
        after,
        `${displayPath(revision.relativePath)} (${revision.kind} ↔ previous)`,
      );
    }),
    vscode.commands.registerCommand(COMPARE_CURRENT_COMMAND, async (input: unknown) => {
      const revision = resolveRevision(input, store.getIndex());
      if (revision === undefined) {
        await vscode.window.showErrorMessage("PromptTrace could not find that revision. Refresh the History view and try again.");
        return;
      }
      const current = currentFileUri(revision.relativePath);
      if (current === undefined) {
        await vscode.window.showErrorMessage(`PromptTrace cannot compare ${displayPath(revision.relativePath)} because its workspace folder is not open.`);
        return;
      }
      try {
        await vscode.workspace.fs.stat(current);
      } catch {
        await vscode.window.showErrorMessage(`PromptTrace cannot compare ${displayPath(revision.relativePath)} because the current file does not exist.`);
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.diff",
        snapshotUri(revision.snapshotId, revision.relativePath, revision.kind),
        current,
        `${displayPath(revision.relativePath)} (${revision.kind} ↔ current)`,
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
    if ("id" in input && typeof input.id === "string") {
      return index.revisions.find((revision) => revision.id === input.id);
    }
  }
  return undefined;
}

function snapshotUri(snapshotId: string | undefined, relativePath: string, label: string): vscode.Uri {
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

function currentFileUri(storedPath: string): vscode.Uri | undefined {
  const separator = storedPath.indexOf("/");
  if (separator < 0) {
    return undefined;
  }
  const folderName = storedPath.slice(0, separator);
  const relativePath = storedPath.slice(separator + 1);
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.name === folderName);
  return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ...relativePath.split("/"));
}

function pathsWithRevisions(index: Readonly<HistoryIndex>): string[] {
  return [...new Set(index.revisions.map((revision) => revision.relativePath))]
    .sort((left, right) => left.localeCompare(right));
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
