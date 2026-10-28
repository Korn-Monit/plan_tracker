import * as vscode from "vscode";

import { RevisionCapture } from "./capture";
import { HistoryIndex, SnapshotStore } from "./history";
import { getSmokeTestMessage } from "./smoke";

const SMOKE_TEST_COMMAND = "promptTrace.runSmokeTest";

export interface PromptTraceApi {
  getHistoryIndex(): Readonly<HistoryIndex>;
  readSnapshot(snapshotId: string): Promise<string>;
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
    const capture = new RevisionCapture(store, (message) => {
      void vscode.window.showErrorMessage(message);
    });
    await capture.start();
    context.subscriptions.push(capture);
    return {
      getHistoryIndex: () => store.getIndex(),
      readSnapshot: (snapshotId) => store.readSnapshot(snapshotId),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(`PromptTrace could not start history capture: ${message}`);
    return undefined;
  }
}

export function deactivate(): void {
  // No resources live beyond the subscriptions owned by the extension context.
}
