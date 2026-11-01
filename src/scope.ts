import * as vscode from "vscode";

import { ScopeMatcher, DEFAULT_MARKDOWN_INCLUDES } from "./scopeMatcher";
import { normalizeRelativePath, workspaceStorageKey } from "./workspacePath";

const IGNORE_FILE = ".plantrackerignore";

export interface ScopeChange {
  wasStoredPathIncluded(storedPath: string): boolean;
}

export class WorkspaceScope implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ScopeChange>();
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private matchers = new Map<string, ScopeMatcher>();
  private includes: readonly string[] = DEFAULT_MARKDOWN_INCLUDES;
  private excludes: readonly string[] = [];
  public readonly onDidChange = this.changed.event;

  public constructor(private readonly reportWarning: (message: string) => void) {}

  public async initialize(): Promise<void> {
    this.reloadConfiguration();
    await this.reloadAll(false);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, IGNORE_FILE));
      const reload = (): void => { void this.reloadAll(true); };
      this.disposables.push(watcher, watcher.onDidCreate(reload), watcher.onDidChange(reload), watcher.onDidDelete(reload));
    }
    this.disposables.push(
      vscode.workspace.onDidRenameFiles((event) => {
        if (event.files.some((file) => isIgnoreFile(file.oldUri) || isIgnoreFile(file.newUri))) {
          void this.reloadAll(true);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("planTracker.include") || event.affectsConfiguration("planTracker.exclude")) {
          this.reloadConfiguration();
          void this.reloadAll(true);
        }
      }),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  public includesUri(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") return false;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) return false;
    return this.matcherFor(folder)?.includesPath(pathWithinFolder(folder, uri)) ?? false;
  }

  public includesStoredPath(storedPath: string): boolean {
    return includesStoredPath(this.matchers, storedPath);
  }

  private reloadConfiguration(): void {
    const configuration = vscode.workspace.getConfiguration("planTracker");
    this.includes = configuration.get<string[]>("include", [...DEFAULT_MARKDOWN_INCLUDES]);
    this.excludes = configuration.get<string[]>("exclude", []);
  }

  private async reloadAll(notify: boolean): Promise<void> {
    const previous = this.matchers;
    const next = new Map(previous);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const key = workspaceStorageKey(folder);
      const ignoreText = await this.readIgnoreFile(folder);
      if (ignoreText === undefined) {
        if (!next.has(key)) {
          next.set(key, new ScopeMatcher({ includes: this.includes, excludes: this.excludes }));
        }
        continue;
      }
      try {
        next.set(key, new ScopeMatcher({ ignoreText, includes: this.includes, excludes: this.excludes }));
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        this.reportWarning(`Plan Tracker could not apply ${vscode.Uri.joinPath(folder.uri, IGNORE_FILE).fsPath}: ${detail} Fix the rules to resume scope updates.`);
        if (!next.has(key)) {
          next.set(key, new ScopeMatcher({ includes: this.includes, excludes: this.excludes }));
        }
      }
    }
    this.matchers = next;
    if (notify) {
      this.changed.fire({ wasStoredPathIncluded: (storedPath) => includesStoredPath(previous, storedPath) });
    }
  }

  private async readIgnoreFile(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
    const uri = vscode.Uri.joinPath(folder.uri, IGNORE_FILE);
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch (error: unknown) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return "";
      const detail = error instanceof Error ? error.message : String(error);
      this.reportWarning(`Plan Tracker could not read ${uri.fsPath}: ${detail} The last valid scope remains active.`);
      return undefined;
    }
  }

  private matcherFor(folder: vscode.WorkspaceFolder): ScopeMatcher | undefined {
    return this.matchers.get(workspaceStorageKey(folder));
  }
}

function includesStoredPath(matchers: ReadonlyMap<string, ScopeMatcher>, storedPath: string): boolean {
  const separator = storedPath.indexOf("/");
  if (separator < 0) return false;
  const key = storedPath.slice(0, separator);
  const relativePath = storedPath.slice(separator + 1);
  const direct = matchers.get(key);
  if (direct !== undefined) return direct.includesPath(relativePath);
  const compatible = [...matchers.entries()].find(([candidate]) => candidate.split("#", 1)[0] === key)?.[1];
  return compatible?.includesPath(relativePath) ?? false;
}

function pathWithinFolder(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  const folderPath = folder.uri.path.endsWith("/") ? folder.uri.path : `${folder.uri.path}/`;
  return normalizeRelativePath(uri.path.slice(folderPath.length));
}

function isIgnoreFile(uri: vscode.Uri): boolean {
  return uri.path.split("/").at(-1) === IGNORE_FILE;
}
