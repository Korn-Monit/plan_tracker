import * as vscode from "vscode";

import { ClaudeCodeAdapter, SessionCoordinator } from "./agent";
import { RevisionCapture } from "./capture";
import { HistoryIndex, SnapshotStore } from "./history";
import { getSmokeTestMessage } from "./smoke";
import { RESTORE_COMMAND, RestoreService } from "./restore";
import { registerTimeline } from "./timeline";

const SMOKE_TEST_COMMAND = "promptTrace.runSmokeTest";

export interface PromptTraceApi {
  getHistoryIndex(): Readonly<HistoryIndex>;
  readSnapshot(snapshotId: string): Promise<string>;
  handleClaudeHook(payload: unknown): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<PromptTraceApi | undefined> {
  const smokeTestCommand = vscode.commands.registerCommand(
    SMOKE_TEST_COMMAND,
    async (): Promise<void> => {
      const isEnabled = vscode.workspace
        .getConfiguration("promptTrace")
        .get<boolean>("enabled", true);

      await vscode.window.showInformationMessage(getSmokeTestMessage(isEnabled));
    },
  );

  context.subscriptions.push(smokeTestCommand);

  const isEnabled = vscode.workspace
    .getConfiguration("promptTrace")
    .get<boolean>("enabled", true);
  if (!isEnabled || context.storageUri === undefined || vscode.workspace.workspaceFolders === undefined) {
    return undefined;
  }

  try {
    const store = new SnapshotStore(context.storageUri.fsPath);
    await store.initialize();
    registerTimeline(context, store);
    const restore = new RestoreService(store);
    const restoreCommand = vscode.commands.registerCommand(RESTORE_COMMAND, async (input: unknown) => {
      const revision = resolveRevision(input, store.getIndex());
      if (revision === undefined) {
        await vscode.window.showErrorMessage("PromptTrace could not find that revision. Refresh the History view and try again.");
        return;
      }
      await restore.restore(revision);
    });
    const capture = new RevisionCapture(store, (message) => {
      void vscode.window.showErrorMessage(message);
    });
    await capture.start();
    const adapter = new ClaudeCodeAdapter(false);
    const coordinator = new SessionCoordinator(store, () => capture.synchronize());
    const handleClaudeHook = async (payload: unknown): Promise<void> => {
      const event = adapter.adapt(payload);
      if (event === undefined) {
        throw new Error("PromptTrace received an invalid or unsupported Claude Code hook payload.");
      }
      await coordinator.accept(event);
    };
    const claudeHookCommand = vscode.commands.registerCommand(
      "promptTrace.handleClaudeHook",
      handleClaudeHook,
    );
    context.subscriptions.push(capture, claudeHookCommand, restoreCommand);
    return {
      getHistoryIndex: () => store.getIndex(),
      readSnapshot: (snapshotId) => store.readSnapshot(snapshotId),
      handleClaudeHook,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`PromptTrace could not start history capture: ${message}`);
    return undefined;
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
