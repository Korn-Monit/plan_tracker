import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import type { PromptTraceApi } from "../extension";
import { SnapshotStore, hashContent } from "../history";
import { RestoreService, RestoreUI } from "../restore";

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
  } else if (phase === "timeline") {
    await runTimelinePhase(folder, api);
  } else if (phase === "attribution") {
    await runAttributionPhase(folder, api);
  } else if (phase === "restore") {
    await runRestorePhase(folder);
  } else {
    assert.fail(`Unknown integration phase: ${String(phase)}`);
  }
}

async function runRestorePhase(folder: vscode.WorkspaceFolder): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("promptTrace.restoreRevision"));

  const storeRoot = await mkdtemp(path.join(tmpdir(), "prompttrace-restore-test-"));
  const originalUri = vscode.Uri.joinPath(folder.uri, "restore-test.md");
  const renamedUri = vscode.Uri.joinPath(folder.uri, "restore-test-renamed.md");
  const storedPath = `${folder.name}/restore-test.md`;
  const confirmations: Array<{ message: string; detail: string }> = [];
  const errors: string[] = [];
  const successes: string[] = [];
  const ui: RestoreUI = {
    async confirm(message, detail) {
      confirmations.push({ message, detail });
      return true;
    },
    async success(message) {
      successes.push(message);
      return false;
    },
    async error(message) {
      errors.push(message);
    },
  };

  try {
    const store = new SnapshotStore(storeRoot);
    await store.initialize();
    const oldRevision = await store.recordContent(storedPath, "historical\n", "baseline");
    assert.ok(oldRevision);
    const currentRevision = await store.recordContent(storedPath, "current work\n", "edited");
    assert.ok(currentRevision);
    await vscode.workspace.fs.writeFile(originalUri, new TextEncoder().encode("current work\n"));

    const service = new RestoreService(store, ui);
    const restored = await service.restore(oldRevision);
    assert.equal(restored.status, "restored");
    assert.equal(decode(await vscode.workspace.fs.readFile(originalUri)), "historical\n");
    assert.equal(restored.status === "restored" ? restored.safetySnapshotId : undefined, hashContent("current work\n"));
    assert.equal(store.getIndex().revisions.at(-1)?.previousSnapshotId, hashContent("current work\n"));
    assert.match(confirmations[0]?.message ?? "", /restore-test\.md/u);
    assert.match(confirmations[0]?.message ?? "", new RegExp(new Date(oldRevision.recordedAt).getFullYear().toString(), "u"));
    assert.match(confirmations[0]?.detail ?? "", /replaced.*safety snapshot/iu);
    assert.equal(successes.length, 1);

    const undone = await service.restore(currentRevision);
    assert.equal(undone.status, "restored");
    assert.equal(decode(await vscode.workspace.fs.readFile(originalUri)), "current work\n");

    const document = await vscode.workspace.openTextDocument(originalUri);
    await vscode.window.showTextDocument(document);
    const dirtyEdit = new vscode.WorkspaceEdit();
    dirtyEdit.replace(document.uri, fullDocumentRange(document), "unsaved work\n");
    assert.equal(await vscode.workspace.applyEdit(dirtyEdit), true);
    assert.equal(document.isDirty, true);
    const dirtyResult = await service.restore(oldRevision);
    assert.equal(dirtyResult.status, "dirty");
    assert.equal(decode(await vscode.workspace.fs.readFile(originalUri)), "current work\n");
    assert.match(errors.at(-1) ?? "", /unsaved changes/iu);
    await vscode.commands.executeCommand("workbench.action.files.revert");

    await vscode.workspace.fs.rename(originalUri, renamedUri);
    const recreated = await service.restore(oldRevision);
    assert.equal(recreated.status, "restored");
    assert.equal(decode(await vscode.workspace.fs.readFile(originalUri)), "historical\n");
    assert.equal(decode(await vscode.workspace.fs.readFile(renamedUri)), "current work\n");
    assert.match(confirmations.at(-1)?.detail ?? "", /missing.*recreated.*No renamed destination/isu);
    assert.equal(errors.length, 1);
  } finally {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await deleteIfPresent(originalUri);
    await deleteIfPresent(renamedUri);
    await rm(storeRoot, { recursive: true, force: true });
  }
}

async function runAttributionPhase(folder: vscode.WorkspaceFolder, api: PromptTraceApi): Promise<void> {
  const storedPath = `${folder.name}/baseline.md`;
  const uri = vscode.Uri.joinPath(folder.uri, "baseline.md");
  const beforeSnapshotId = api.getHistoryIndex().heads[storedPath]?.snapshotId;
  assert.ok(beforeSnapshotId);

  await api.handleClaudeHook({
    session_id: "sanitized-session-1",
    hook_event_name: "UserPromptSubmit",
    prompt: "This text must not be persisted by default",
  });
  const countBeforeWrites = revisionsFor(api, storedPath).length;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode("agent intermediate\n"));
  await waitFor(() => revisionsFor(api, storedPath).length === countBeforeWrites + 1);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode("agent final\n"));
  await waitFor(() => revisionsFor(api, storedPath).length === countBeforeWrites + 2);
  await api.handleClaudeHook({
    session_id: "sanitized-session-1",
    hook_event_name: "Stop",
    stop_hook_active: false,
  });

  const changes = api.getHistoryIndex().changes;
  assert.equal(changes.length, 1, "one prompt must create exactly one Change");
  const change = changes[0];
  assert.ok(change);
  assert.equal(change.status, "completed");
  assert.equal(change.attribution, "attributed");
  assert.equal(change.promptPreview, undefined, "prompt text is metadata-only by default");
  assert.equal(change.files.length, 1);
  assert.equal(change.files[0]?.relativePath, storedPath);
  assert.equal(change.files[0]?.beforeSnapshotId, beforeSnapshotId);
  const afterSnapshotId = change.files[0]?.afterSnapshotId;
  assert.ok(afterSnapshotId);
  assert.equal(await api.readSnapshot(afterSnapshotId), "agent final\n");
  assert.equal(revisionsFor(api, storedPath).slice(-2).every((revision) => revision.changeId === change.id), true);

  const revisionCount = revisionsFor(api, storedPath).length;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode("manual after prompt\n"));
  await waitFor(() => revisionsFor(api, storedPath).length === revisionCount + 1);
  assert.equal(revisionsFor(api, storedPath).at(-1)?.changeId, undefined, "manual edits must remain unassigned");
  assert.equal(api.getHistoryIndex().changes.length, 1);
}

async function runTimelinePhase(folder: vscode.WorkspaceFolder, api: PromptTraceApi): Promise<void> {
  const baselinePath = `${folder.name}/baseline.md`;
  const revisions = revisionsFor(api, baselinePath);
  assert.equal(revisions.length, 6, "timeline test requires the persisted Phase 1 revisions");
  const latest = revisions.at(-1);
  assert.ok(latest?.snapshotId);
  assert.ok(latest.previousSnapshotId);

  const registeredCommands = await vscode.commands.getCommands(true);
  assert.ok(registeredCommands.includes("promptTrace.compareWithPrevious"));
  assert.ok(registeredCommands.includes("promptTrace.compareWithCurrent"));

  void vscode.commands.executeCommand("promptTrace.compareWithPrevious", latest.id);
  const previousDiff = await waitForDiffTab();
  assert.equal(previousDiff.original.scheme, "prompttrace-snapshot");
  assert.equal(previousDiff.modified.scheme, "prompttrace-snapshot");
  const beforeDocument = await vscode.workspace.openTextDocument(previousDiff.original);
  const afterDocument = await vscode.workspace.openTextDocument(previousDiff.modified);
  assert.equal(beforeDocument.getText(), await api.readSnapshot(latest.previousSnapshotId));
  assert.equal(afterDocument.getText(), "after restart\n");
  assert.equal(afterDocument.isDirty, false);

  void vscode.commands.executeCommand("promptTrace.compareWithCurrent", latest.id);
  const currentDiff = await waitForDiffTab("file");
  assert.equal(currentDiff.original.scheme, "prompttrace-snapshot");
  assert.equal(currentDiff.modified.scheme, "file");
  assert.equal(currentDiff.modified.fsPath, vscode.Uri.joinPath(folder.uri, "baseline.md").fsPath);
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

async function waitForDiffTab(modifiedScheme?: string): Promise<vscode.TabInputTextDiff> {
  let input: vscode.TabInputTextDiff | undefined;
  await waitFor(() => {
    const candidate = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(candidate instanceof vscode.TabInputTextDiff)) {
      return false;
    }
    if (modifiedScheme !== undefined && candidate.modified.scheme !== modifiedScheme) {
      return false;
    }
    input = candidate;
    return true;
  });
  assert.ok(input);
  return input;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = document.lineAt(document.lineCount - 1);
  return new vscode.Range(new vscode.Position(0, 0), lastLine.rangeIncludingLineBreak.end);
}

async function deleteIfPresent(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri);
  } catch {
    // Cleanup is best-effort when a scenario already removed the file.
  }
}
