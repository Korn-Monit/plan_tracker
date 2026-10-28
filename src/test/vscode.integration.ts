import assert from "node:assert/strict";
import * as vscode from "vscode";

import type { PromptTraceApi } from "../extension";

const EXTENSION_ID = "prompttrace-local.prompttrace";
const TIMEOUT_MS = 10_000;

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "The integration workspace must be open");

  const extension = vscode.extensions.getExtension<PromptTraceApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not discovered`);
  const api = await extension.activate();
  assert.ok(api, "PromptTrace did not return its history API");

  const phase = process.env["PROMPTTRACE_TEST_PHASE"];
  if (phase === "capture") {
    await runCapturePhase(folder, api);
  } else if (phase === "restart") {
    await runRestartPhase(folder, api);
  } else {
    assert.fail(`Unknown integration phase: ${String(phase)}`);
  }
}

async function runCapturePhase(folder: vscode.WorkspaceFolder, api: PromptTraceApi): Promise<void> {
  const baselinePath = `${folder.name}/baseline.md`;
  const excludedPath = `${folder.name}/node_modules/excluded.md`;
  await waitFor(() => api.getHistoryIndex().heads[baselinePath]?.deleted === false);
  assert.equal(api.getHistoryIndex().heads[excludedPath], undefined);

  const baselineUri = vscode.Uri.joinPath(folder.uri, "baseline.md");
  const states = ["first edit\n", "", "Unicode: café 日本語 ✨\n", `${"large line\n".repeat(100_000)}`];
  for (const [index, content] of states.entries()) {
    await vscode.workspace.fs.writeFile(baselineUri, new TextEncoder().encode(content));
    await waitFor(() => revisionsFor(api, baselinePath).length === index + 2);
  }

  const finalHead = api.getHistoryIndex().heads[baselinePath];
  assert.ok(finalHead?.snapshotId);
  assert.equal(await api.readSnapshot(finalHead.snapshotId), states.at(-1));

  const createdUri = vscode.Uri.joinPath(folder.uri, "created.md");
  const renamedUri = vscode.Uri.joinPath(folder.uri, "renamed.md");
  await vscode.workspace.fs.writeFile(createdUri, new TextEncoder().encode("created\n"));
  await waitFor(() => api.getHistoryIndex().heads[`${folder.name}/created.md`]?.deleted === false);

  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(createdUri, renamedUri);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  await waitFor(() => api.getHistoryIndex().heads[`${folder.name}/renamed.md`]?.deleted === false);

  await vscode.workspace.fs.delete(renamedUri);
  await waitFor(() => api.getHistoryIndex().heads[`${folder.name}/renamed.md`]?.deleted === true);
  assert.equal(api.getHistoryIndex().heads[excludedPath], undefined);
}

async function runRestartPhase(folder: vscode.WorkspaceFolder, api: PromptTraceApi): Promise<void> {
  const baselinePath = `${folder.name}/baseline.md`;
  const revisionsBeforeEdit = revisionsFor(api, baselinePath);
  assert.equal(revisionsBeforeEdit.length, 5, "all baseline and saved states must survive restart");

  const expectedStates = ["baseline\n", "first edit\n", "", "Unicode: café 日本語 ✨\n"];
  const contents = await Promise.all(revisionsBeforeEdit
    .filter((revision) => revision.snapshotId !== undefined)
    .map((revision) => api.readSnapshot(revision.snapshotId!)));
  for (const expected of expectedStates) {
    assert.ok(contents.includes(expected));
  }

  const baselineUri = vscode.Uri.joinPath(folder.uri, "baseline.md");
  await vscode.workspace.fs.writeFile(baselineUri, new TextEncoder().encode("after restart\n"));
  await waitFor(() => revisionsFor(api, baselinePath).length === 6);
  assert.equal(api.getHistoryIndex().heads[`${folder.name}/node_modules/excluded.md`], undefined);
}

function revisionsFor(api: PromptTraceApi, relativePath: string): ReturnType<PromptTraceApi["getHistoryIndex"]>["revisions"] {
  return api.getHistoryIndex().revisions.filter((revision) => revision.relativePath === relativePath);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > TIMEOUT_MS) {
      assert.fail("Timed out waiting for PromptTrace history capture");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
