import * as vscode from "vscode";

import { matchesAnyGlob } from "./glob";
import { SnapshotStore } from "./history";
import { normalizeRelativePath, storedWorkspacePath, workspaceStorageKey } from "./workspacePath";

const DEFAULT_INCLUDES = ["**/*.md", "**/*.markdown"];
const DEFAULT_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/.plan-tracker/**",
  "**/.vscode-test/**",
];

interface ScopedPath {
  folder: vscode.WorkspaceFolder;
  relativePath: string;
  storagePath: string;
}

export class RevisionCapture implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private includes = DEFAULT_INCLUDES;
  private excludes = DEFAULT_EXCLUDES;
  private disposed = false;

  public constructor(
    private readonly store: SnapshotStore,
    private readonly reportError: (message: string) => void,
  ) {}

  public async start(): Promise<void> {
    this.reloadConfiguration();
    await this.scanWorkspace();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const include of this.includes) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, include),
        );
        this.disposables.push(
          watcher,
          watcher.onDidCreate((uri) => this.scheduleCapture(uri)),
          watcher.onDidChange((uri) => this.scheduleCapture(uri)),
          watcher.onDidDelete((uri) => this.scheduleDeletion(uri)),
        );
      }
    }

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        const scoped = this.scope(document.uri);
        if (scoped !== undefined) {
          this.cancelTimer(scoped.storagePath);
          void this.captureText(scoped, document.getText(), "edited");
        }
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
          void this.captureRename(file.oldUri, file.newUri);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("planTracker")) {
          this.reloadConfiguration();
        }
      }),
    );
  }

  public dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Flushes debounced filesystem state before an agent turn boundary is recorded. */
  public async synchronize(): Promise<void> {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    await this.scanWorkspace();
  }

  private reloadConfiguration(): void {
    const configuration = vscode.workspace.getConfiguration("planTracker");
    this.includes = configuration.get<string[]>("include", DEFAULT_INCLUDES);
    this.excludes = configuration.get<string[]>("exclude", DEFAULT_EXCLUDES);
  }

  private async scanWorkspace(): Promise<void> {
    const discovered = new Set<string>();
    for (const include of this.includes) {
      const uris = await vscode.workspace.findFiles(include, null);
      for (const uri of uris) {
        const scoped = this.scope(uri);
        if (scoped === undefined || discovered.has(scoped.storagePath)) {
          continue;
        }
        discovered.add(scoped.storagePath);
        const content = await this.readWithRetry(uri);
        if (content === undefined) {
          continue;
        }
        const kind = this.store.getHead(scoped.storagePath) === undefined ? "baseline" : "edited";
        await this.store.recordContent(scoped.storagePath, content, kind);
      }
    }

    for (const [storedPath, head] of Object.entries(this.store.getIndex().heads)) {
      if (!head.deleted && this.belongsToTrackedOpenWorkspace(storedPath) && !discovered.has(storedPath)) {
        await this.store.recordDeletion(storedPath);
      }
    }
  }

  private scheduleCapture(uri: vscode.Uri): void {
    const scoped = this.scope(uri);
    if (scoped === undefined) {
      return;
    }
    this.replaceTimer(scoped.storagePath, async () => {
      const content = await this.readWithRetry(uri);
      if (content !== undefined) {
        await this.captureText(scoped, content, "edited");
      }
    });
  }

  private scheduleDeletion(uri: vscode.Uri): void {
    const scoped = this.scope(uri);
    if (scoped === undefined) {
      return;
    }
    this.replaceTimer(scoped.storagePath, async () => {
      await this.store.recordDeletion(scoped.storagePath);
    });
  }

  private async captureRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const oldPath = this.scope(oldUri);
    const newPath = this.scope(newUri);
    if (oldPath !== undefined) {
      this.cancelTimer(oldPath.storagePath);
    }
    if (newPath !== undefined) {
      this.cancelTimer(newPath.storagePath);
    }

    try {
      if (oldPath !== undefined && newPath !== undefined) {
        const content = await this.readWithRetry(newUri);
        if (content !== undefined) {
          await this.store.recordRename(oldPath.storagePath, newPath.storagePath, content);
        }
      } else if (oldPath !== undefined) {
        await this.store.recordDeletion(oldPath.storagePath);
      } else if (newPath !== undefined) {
        const content = await this.readWithRetry(newUri);
        if (content !== undefined) {
          await this.captureText(newPath, content, "created");
        }
      }
    } catch (error: unknown) {
      this.report(error);
    }
  }

  private async captureText(
    scoped: ScopedPath,
    content: string,
    kind: "baseline" | "created" | "edited",
  ): Promise<void> {
    try {
      await this.store.recordContent(scoped.storagePath, content, kind);
    } catch (error: unknown) {
      this.report(error);
    }
  }

  private scope(uri: vscode.Uri): ScopedPath | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) {
      return undefined;
    }
    const relativePath = normalizeRelativePath(pathWithinFolder(folder, uri));
    if (!matchesAnyGlob(relativePath, this.includes) || matchesAnyGlob(relativePath, this.excludes)) {
      return undefined;
    }
    return {
      folder,
      relativePath,
      storagePath: storedWorkspacePath(folder, relativePath),
    };
  }

  private belongsToTrackedOpenWorkspace(storedPath: string): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
      const prefix = `${workspaceStorageKey(folder)}/`;
      if (!storedPath.startsWith(prefix)) {
        return false;
      }
      const relativePath = storedPath.slice(prefix.length);
      return matchesAnyGlob(relativePath, this.includes)
        && !matchesAnyGlob(relativePath, this.excludes);
    });
  }

  private replaceTimer(key: string, operation: () => Promise<void>): void {
    this.cancelTimer(key);
    const configuration = vscode.workspace.getConfiguration("planTracker");
    const delay = configuration.get<number>("debounceMilliseconds", 250);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (!this.disposed) {
        void operation().catch((error: unknown) => this.report(error));
      }
    }, delay);
    this.timers.set(key, timer);
  }

  private cancelTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  private async readWithRetry(uri: vscode.Uri): Promise<string | undefined> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch (error: unknown) {
        if (attempt === 3) {
          this.report(error);
          return undefined;
        }
        await wait(50 * (attempt + 1));
      }
    }
    return undefined;
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.reportError(`Plan Tracker could not record history: ${message}`);
  }
}

function pathWithinFolder(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  const folderPath = folder.uri.path.endsWith("/") ? folder.uri.path : `${folder.uri.path}/`;
  return uri.path.slice(folderPath.length);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
