import { createHash } from "node:crypto";
import * as vscode from "vscode";

export function workspaceStorageKey(
  folder: vscode.WorkspaceFolder,
  folders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders ?? [],
): string {
  const duplicates = folders.filter((candidate) => candidate.name === folder.name);
  if (duplicates.length <= 1) return folder.name;
  const suffix = createHash("sha256").update(folder.uri.toString()).digest("hex").slice(0, 8);
  return `${folder.name}#${suffix}`;
}

export function storedWorkspacePath(folder: vscode.WorkspaceFolder, relativePath: string): string {
  return `${workspaceStorageKey(folder)}/${normalizeRelativePath(relativePath)}`;
}

export function resolveStoredWorkspacePath(storedPath: string): vscode.Uri | undefined {
  const separator = storedPath.indexOf("/");
  if (separator < 0) return undefined;
  const key = storedPath.slice(0, separator);
  const relativePath = storedPath.slice(separator + 1);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = folders.find((candidate) => workspaceStorageKey(candidate, folders) === key)
    // Compatibility with history recorded before duplicate-root disambiguation.
    ?? folders.find((candidate) => candidate.name === key);
  return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ...relativePath.split("/"));
}

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}
