import * as vscode from "vscode";

import { Revision, SnapshotStore } from "./history";
import { snapshotUri } from "./timeline";

export const RESTORE_COMMAND = "promptTrace.restoreRevision";

export type RestoreResult =
  | { status: "restored"; target: vscode.Uri; safetySnapshotId?: string }
  | { status: "cancelled" | "dirty" | "unavailable" | "failed" };

export interface RestoreUI {
  confirm(message: string, detail: string): Promise<boolean>;
  success(message: string): Promise<boolean>;
  error(message: string): Promise<void>;
}

const defaultUI: RestoreUI = {
  async confirm(message, detail) {
    return await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      "Restore",
    ) === "Restore";
  },
  async success(message) {
    return await vscode.window.showInformationMessage(message, "Compare Restore") === "Compare Restore";
  },
  async error(message) {
    await vscode.window.showErrorMessage(message);
  },
};

export class RestoreService {
  public constructor(
    private readonly store: SnapshotStore,
    private readonly ui: RestoreUI = defaultUI,
  ) {}

  public async restore(revision: Revision): Promise<RestoreResult> {
    if (revision.snapshotId === undefined) {
      await this.ui.error("PromptTrace cannot restore this revision because it represents a deleted file and has no file content.");
      return { status: "unavailable" };
    }

    const target = workspaceFileUri(revision.relativePath);
    if (target === undefined) {
      await this.ui.error(`PromptTrace cannot restore ${displayPath(revision.relativePath)} because its recorded workspace folder is not open.`);
      return { status: "unavailable" };
    }

    if (dirtyDocument(target) !== undefined) {
      await this.ui.error(`PromptTrace did not restore ${displayPath(revision.relativePath)} because it has unsaved changes. Save or revert the editor, then try again.`);
      return { status: "dirty" };
    }

    let exists: boolean;
    try {
      exists = await fileExists(target);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.ui.error(`PromptTrace could not inspect ${displayPath(revision.relativePath)} before restore: ${reason} No file was changed.`);
      return { status: "failed" };
    }
    const revisionTime = new Date(revision.recordedAt).toLocaleString();
    const consequence = exists
      ? "The file on disk will be replaced. PromptTrace will first preserve its current contents as a safety snapshot."
      : "The file is currently missing and will be recreated at its recorded path. No renamed destination will be changed.";
    const confirmed = await this.ui.confirm(
      `Restore ${displayPath(revision.relativePath)} from ${revisionTime}?`,
      consequence,
    );
    if (!confirmed) {
      return { status: "cancelled" };
    }

    // The user may have edited the document while the modal confirmation was open.
    if (dirtyDocument(target) !== undefined) {
      await this.ui.error(`PromptTrace did not restore ${displayPath(revision.relativePath)} because it acquired unsaved changes while restore was being confirmed.`);
      return { status: "dirty" };
    }

    let safetySnapshotId: string | undefined;
    try {
      const currentContent = await readCurrentFile(target);
      exists = currentContent !== undefined;
      if (currentContent !== undefined) {
        const safetyRevision = await this.store.recordContent(revision.relativePath, currentContent, "edited");
        safetySnapshotId = safetyRevision?.snapshotId ?? this.store.getHead(revision.relativePath)?.snapshotId;
      }

      const restoredContent = await this.store.readSnapshot(revision.snapshotId);
      if (!exists) {
        await vscode.workspace.fs.createDirectory(parentUri(target));
      }
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(restoredContent));
      await this.store.recordContent(revision.relativePath, restoredContent, exists ? "edited" : "created");
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      const safety = safetySnapshotId === undefined
        ? "No existing file content was overwritten."
        : "The pre-restore safety snapshot remains in PromptTrace history.";
      await this.ui.error(`PromptTrace could not restore ${displayPath(revision.relativePath)}: ${reason} ${safety}`);
      return { status: "failed" };
    }

    const compare = await this.ui.success(`Restored ${displayPath(revision.relativePath)}. The previous contents remain available in PromptTrace history.`);
    if (compare) {
      await vscode.commands.executeCommand(
        "vscode.diff",
        snapshotUri(safetySnapshotId, revision.relativePath, "before-restore"),
        target,
        `${displayPath(revision.relativePath)} (before restore ↔ restored)`,
      );
    }
    return { status: "restored", target, safetySnapshotId };
  }
}

export function workspaceFileUri(storedPath: string): vscode.Uri | undefined {
  const separator = storedPath.indexOf("/");
  if (separator < 0) {
    return undefined;
  }
  const folderName = storedPath.slice(0, separator);
  const relativePath = storedPath.slice(separator + 1);
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.name === folderName);
  return folder === undefined ? undefined : vscode.Uri.joinPath(folder.uri, ...relativePath.split("/"));
}

function dirtyDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString() && document.isDirty);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function readCurrentFile(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return decode(await vscode.workspace.fs.readFile(uri));
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === "FileNotFound";
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  const separator = uri.path.lastIndexOf("/");
  return uri.with({ path: separator <= 0 ? "/" : uri.path.slice(0, separator) });
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function displayPath(storedPath: string): string {
  const separator = storedPath.indexOf("/");
  return separator < 0 ? storedPath : storedPath.slice(separator + 1);
}
