import * as vscode from "vscode";

import { getSmokeTestMessage } from "./smoke";

const SMOKE_TEST_COMMAND = "promptTrace.runSmokeTest";

export function activate(context: vscode.ExtensionContext): void {
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
}

export function deactivate(): void {
  // No resources live beyond the subscriptions owned by the extension context.
}
