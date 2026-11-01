import * as vscode from "vscode";

import { ClaudeCodeAdapter, SessionCoordinator } from "./agent";
import { RevisionCapture } from "./capture";
import { HistoryIndex, SnapshotStore } from "./history";
import { filterHistoryIndex } from "./historyScope";
import { getSmokeTestMessage } from "./smoke";
import { RESTORE_COMMAND, RestoreService } from "./restore";
import { WorkspaceScope } from "./scope";
import { registerTimeline } from "./timeline";

const SMOKE_TEST_COMMAND = "planTracker.runSmokeTest";
const DELETE_HISTORY_COMMAND = "planTracker.deleteWorkspaceHistory";

export interface PlanTrackerApi {
  getHistoryIndex(): Readonly<HistoryIndex>;
  getVisibleHistoryIndex(): Readonly<HistoryIndex>;
  isPathIncluded(storedPath: string): boolean;
  readSnapshot(snapshotId: string): Promise<string>;
  handleClaudeHook(payload: unknown): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<PlanTrackerApi | undefined> {
  const smokeTestCommand = vscode.commands.registerCommand(
    SMOKE_TEST_COMMAND,
    async (): Promise<void> => {
      const isEnabled = vscode.workspace
        .getConfiguration("planTracker")
        .get<boolean>("enabled", true);

      await vscode.window.showInformationMessage(getSmokeTestMessage(isEnabled));
    },
  );

  context.subscriptions.push(smokeTestCommand);

  const isEnabled = vscode.workspace
    .getConfiguration("planTracker")
    .get<boolean>("enabled", true);
  if (!isEnabled || context.storageUri === undefined || vscode.workspace.workspaceFolders === undefined) {
    return undefined;
  }

  try {
    const store = new SnapshotStore(context.storageUri.fsPath);
    await store.initialize();
    if (store.getRecoveryNotice() !== undefined) {
      await vscode.window.showWarningMessage(store.getRecoveryNotice()!);
    }
    await enforceRetention(store);
    const scopeMatcher = new WorkspaceScope((message) => {
      void vscode.window.showWarningMessage(message);
    });
    await scopeMatcher.initialize();
    context.subscriptions.push(scopeMatcher);
    registerTimeline(context, store, scopeMatcher);
    const restore = new RestoreService(store);
    const restoreCommand = vscode.commands.registerCommand(RESTORE_COMMAND, async (input: unknown) => {
      const revision = resolveRevision(input, store.getIndex());
      if (revision === undefined) {
        await vscode.window.showErrorMessage("Plan Tracker could not find that revision. Refresh the History view and try again.");
        return;
      }
      await restore.restore(revision);
    });
    const capture = new RevisionCapture(store, scopeMatcher, (message) => {
      void vscode.window.showErrorMessage(message);
    });
    await capture.start();
    const deleteHistoryCommand = vscode.commands.registerCommand(DELETE_HISTORY_COMMAND, async () => {
      const choice = await vscode.window.showWarningMessage(
        "Delete all Plan Tracker history for this workspace?",
        {
          modal: true,
          detail: "This permanently deletes revisions, prompt attribution, safety snapshots, and backup indexes. Current matching files will be recorded again as fresh baselines.",
        },
        "Delete History",
      );
      if (choice !== "Delete History") return;
      await store.clear();
      await capture.synchronize();
      await vscode.window.showInformationMessage("Plan Tracker workspace history was deleted. Fresh baselines were created for current files.");
    });
    const retentionConfiguration = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("planTracker.maxAgeDays")
        || event.affectsConfiguration("planTracker.maxStorageMegabytes")) {
        void enforceRetention(store);
      }
    });
    const adapter = new ClaudeCodeAdapter(false);
    const coordinator = new SessionCoordinator(store, () => capture.synchronize());
    const handleClaudeHook = async (payload: unknown): Promise<void> => {
      const event = adapter.adapt(payload);
      if (event === undefined) {
        throw new Error("Plan Tracker received an invalid or unsupported Claude Code hook payload.");
      }
      await coordinator.accept(event);
    };
    const claudeHookCommand = vscode.commands.registerCommand(
      "planTracker.handleClaudeHook",
      handleClaudeHook,
    );
    context.subscriptions.push(capture, claudeHookCommand, restoreCommand, deleteHistoryCommand, retentionConfiguration);
    return {
      getHistoryIndex: () => store.getIndex(),
      getVisibleHistoryIndex: () => filterHistoryIndex(store.getIndex(), (path) => scopeMatcher.includesStoredPath(path)),
      isPathIncluded: (storedPath) => scopeMatcher.includesStoredPath(storedPath),
      readSnapshot: (snapshotId) => store.readSnapshot(snapshotId),
      handleClaudeHook,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`Plan Tracker could not start history capture: ${message}`);
    return undefined;
  }
}

async function enforceRetention(store: SnapshotStore): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("planTracker");
  const maxAgeDays = configuration.get<number>("maxAgeDays", 90);
  const maxStorageMegabytes = configuration.get<number>("maxStorageMegabytes", 500);
  const result = await store.applyRetention({
    maxAgeDays,
    maxStorageBytes: maxStorageMegabytes <= 0 ? 0 : Math.floor(maxStorageMegabytes * 1024 * 1024),
  });
  if (!result.limitSatisfied) {
    await vscode.window.showWarningMessage(
      "Plan Tracker could not meet the storage limit because current file snapshots alone exceed it. Current snapshots were preserved.",
    );
  }
}

function resolveRevision(input: unknown, index: Readonly<HistoryIndex>): HistoryIndex["revisions"][number] | undefined {
  if (typeof input === "string") {
    return index.revisions.find((revision) => revision.id === input);
  }
  if (typeof input === "object" && input !== null) {
    if ("relativePath" in input && typeof input.relativePath === "string"
      && "recordedAt" in input && typeof input.recordedAt === "string") {
      return input as HistoryIndex["revisions"][number];
    }
    if ("id" in input && typeof input.id === "string") {
      return index.revisions.find((revision) => revision.id === input.id);
    }
  }
  return undefined;
}

export function deactivate(): void {
  // No resources live beyond the subscriptions owned by the extension context.
}
