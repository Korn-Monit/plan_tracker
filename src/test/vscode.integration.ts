import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import type { PlanTrackerApi } from "../extension";
import { SnapshotStore, hashContent } from "../history";
import { RestoreService, RestoreUI } from "../restore";
import { normalizeRelativePath, workspaceStorageKey } from "../workspacePath";

const EXTENSION_ID = "MonitKorn.plan-tracker";
const TIMEOUT_MS = 10_000;

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "The integration workspace must be open");

  const extension = vscode.extensions.getExtension<PlanTrackerApi>(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not discovered`);
  const api = await extension.activate();
  assert.ok(api, "Plan Tracker did not return its history API");

  const phase = process.env["PLAN_TRACKER_TEST_PHASE"];
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
  } else if (phase === "hardening") {
    await runHardeningPhase();
  } else if (phase === "scope") {
    await runScopePhase(folder, api);
  } else if (phase === "package-smoke") {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("planTracker.runSmokeTest"));
    assert.ok(commands.includes("planTracker.deleteWorkspaceHistory"));
    assert.ok(api.getHistoryIndex().schemaVersion === 2);
  } else {
    assert.fail(`Unknown integration phase: ${String(phase)}`);
  }
}

async function runScopePhase(folder: vscode.WorkspaceFolder, api: PlanTrackerApi): Promise<void> {
  const privatePath = `${folder.name}/scope-private.md`;
  const includedPath = `${folder.name}/scope-included.md`;
  const privateUri = vscode.Uri.joinPath(folder.uri, "scope-private.md");
  const includedUri = vscode.Uri.joinPath(folder.uri, "scope-included.md");
  const ignoreUri = vscode.Uri.joinPath(folder.uri, ".plantrackerignore");

  await vscode.workspace.fs.writeFile(privateUri, new TextEncoder().encode("private baseline\n"));
  await vscode.workspace.fs.writeFile(includedUri, new TextEncoder().encode("included baseline\n"));
  await waitFor(() => api.getHistoryIndex().heads[privatePath]?.deleted === false
    && api.getHistoryIndex().heads[includedPath]?.deleted === false);
  const privateRevisionCount = revisionsFor(api, privatePath).length;
  const includedRevisionCount = revisionsFor(api, includedPath).length;

  await vscode.workspace.fs.writeFile(ignoreUri, new TextEncoder().encode("scope-private.md\n"));
  await waitFor(() => !api.isPathIncluded(privatePath));
  assert.equal(api.getVisibleHistoryIndex().revisions.some((revision) => revision.relativePath === privatePath), false);

  await api.handleClaudeHook({ session_id: "scope-mixed", hook_event_name: "UserPromptSubmit" });
  await vscode.workspace.fs.writeFile(privateUri, new TextEncoder().encode("changed while excluded\n"));
  await vscode.workspace.fs.writeFile(includedUri, new TextEncoder().encode("included agent edit\n"));
  await waitFor(() => revisionsFor(api, includedPath).length === includedRevisionCount + 1);
  await api.handleClaudeHook({ session_id: "scope-mixed", hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(revisionsFor(api, privatePath).length, privateRevisionCount);
  const mixed = api.getVisibleHistoryIndex().changes.at(-1);
  assert.deepEqual(mixed?.files.map((file) => file.relativePath), [includedPath]);

  const visibleChangeCount = api.getVisibleHistoryIndex().changes.length;
  await api.handleClaudeHook({ session_id: "scope-private-only", hook_event_name: "UserPromptSubmit" });
  await vscode.workspace.fs.writeFile(privateUri, new TextEncoder().encode("second excluded edit\n"));
  await api.handleClaudeHook({ session_id: "scope-private-only", hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(api.getVisibleHistoryIndex().changes.length, visibleChangeCount, "an excluded-only prompt must not show an empty Change");

  await vscode.workspace.fs.delete(ignoreUri);
  await waitFor(() => api.isPathIncluded(privatePath));
  await waitFor(() => api.getHistoryIndex().heads[privatePath]?.snapshotId === hashContent("second excluded edit\n"));
  assert.equal(revisionsFor(api, privatePath).length, privateRevisionCount, "re-inclusion must not manufacture a revision");
  assert.equal(api.getVisibleHistoryIndex().revisions.some((revision) => revision.relativePath === privatePath), true);

  await vscode.workspace.fs.writeFile(privateUri, new TextEncoder().encode("edit after re-inclusion\n"));
  await waitFor(() => revisionsFor(api, privatePath).length === privateRevisionCount + 1);
  assert.equal(revisionsFor(api, privatePath).at(-1)?.previousSnapshotId, hashContent("second excluded edit\n"));
}

async function runHardeningPhase(): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("planTracker.deleteWorkspaceHistory"));

  const root = await mkdtemp(path.join(tmpdir(), "plan-tracker-hardening-test-"));
  try {
    const store = new SnapshotStore(root);
    await store.initialize();
    const largeContent = `${"representative markdown line\n".repeat(80_000)}large tail`;
    const largeStarted = Date.now();
    await store.recordContent("workspace/large.md", largeContent, "baseline");
    const largeMilliseconds = Date.now() - largeStarted;

    const historyStarted = Date.now();
    for (let index = 0; index < 200; index += 1) {
      await store.recordContent("workspace/history.md", `revision ${index}\n`, index === 0 ? "baseline" : "edited");
    }
    const historyMilliseconds = Date.now() - historyStarted;
    const retained = await store.applyRetention({
      maxAgeDays: 1,
      maxStorageBytes: Buffer.byteLength(largeContent) + 64,
      now: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    });
    assert.equal(store.getIndex().revisions.filter((revision) => revision.relativePath === "workspace/history.md").length, 1);
    assert.equal(store.getHead("workspace/large.md")?.snapshotId, hashContent(largeContent));
    assert.equal(retained.limitSatisfied, true);
    console.log(`Plan Tracker Phase 5 measurements: ${Buffer.byteLength(largeContent)}-byte file captured in ${largeMilliseconds} ms; 200 revisions captured in ${historyMilliseconds} ms.`);

    const missingSnapshot = store.getHead("workspace/history.md")?.snapshotId;
    assert.ok(missingSnapshot);
    await rm(path.join(root, "snapshots", `${missingSnapshot}.md`));
    await assert.rejects(store.readSnapshot(missingSnapshot));
    await store.recordContent("workspace/history.md", "revision 199\n", "edited");
    assert.equal(await store.readSnapshot(missingSnapshot), "revision 199\n");

    await store.clear();
    assert.equal(store.getIndex().revisions.length, 0);
    assert.equal((await readFile(path.join(root, "history-v2.json"), "utf8")).includes("revision 199"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const migrationRoot = await mkdtemp(path.join(tmpdir(), "plan-tracker-migration-test-"));
  try {
    await mkdir(path.join(migrationRoot, "snapshots"), { recursive: true });
    await writeFile(path.join(migrationRoot, "history-v1.json"), JSON.stringify({
      schemaVersion: 1,
      revisions: [{
        id: "legacy-revision",
        relativePath: "workspace/legacy.md",
        snapshotId: "a".repeat(64),
        recordedAt: "2025-01-01T00:00:00.000Z",
        kind: "baseline",
      }],
      heads: { "workspace/legacy.md": { snapshotId: "a".repeat(64), deleted: false } },
    }), "utf8");
    const migrated = new SnapshotStore(migrationRoot);
    await migrated.initialize();
    assert.equal(migrated.getIndex().schemaVersion, 2);
    assert.match(migrated.getRecoveryNotice() ?? "", /migrated/iu);

    await migrated.recordContent("workspace/current.md", "valid", "baseline");
    await migrated.recordContent("workspace/current.md", "valid two", "edited");
    await writeFile(path.join(migrationRoot, "history-v2.json"), "{malformed", "utf8");
    const recovered = new SnapshotStore(migrationRoot);
    await recovered.initialize();
    assert.match(recovered.getRecoveryNotice() ?? "", /backup/iu);
    assert.ok(recovered.getIndex().revisions.length >= 1);
  } finally {
    await rm(migrationRoot, { recursive: true, force: true });
  }

  assert.equal(normalizeRelativePath("docs\\windows\\plan.md"), "docs/windows/plan.md");
  const duplicateA = { name: "workspace", index: 0, uri: vscode.Uri.file("C:\\one\\workspace") } as vscode.WorkspaceFolder;
  const duplicateB = { name: "workspace", index: 1, uri: vscode.Uri.file("D:\\two\\workspace") } as vscode.WorkspaceFolder;
  assert.notEqual(workspaceStorageKey(duplicateA, [duplicateA, duplicateB]), workspaceStorageKey(duplicateB, [duplicateA, duplicateB]));
  assert.equal(workspaceStorageKey(duplicateA, [duplicateB, duplicateA]), workspaceStorageKey(duplicateA, [duplicateA, duplicateB]));
}

async function runRestorePhase(folder: vscode.WorkspaceFolder): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("planTracker.restoreRevision"));

  const storeRoot = await mkdtemp(path.join(tmpdir(), "plan-tracker-restore-test-"));
  const originalUri = vscode.Uri.joinPath(folder.uri, "restore-test.md");
  const renamedUri = vscode.Uri.joinPath(folder.uri, "restore-test-renamed.md");
  const storedPath = `${folder.name}/restore-test.md`;
  const confirmations: Array<{ message: string; detail: string }> = [];
  const errors: string[] = [];
  const successes: string[] = [];
  const ui: RestoreUI = {
    confirm(message, detail) {
      confirmations.push({ message, detail });
      return Promise.resolve(true);
    },
    success(message) {
      successes.push(message);
      return Promise.resolve(false);
    },
    error(message) {
      errors.push(message);
      return Promise.resolve();
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

async function runAttributionPhase(folder: vscode.WorkspaceFolder, api: PlanTrackerApi): Promise<void> {
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

async function runTimelinePhase(folder: vscode.WorkspaceFolder, api: PlanTrackerApi): Promise<void> {
  const baselinePath = `${folder.name}/baseline.md`;
  const revisions = revisionsFor(api, baselinePath);
  assert.equal(revisions.length, 6, "timeline test requires the persisted Phase 1 revisions");
  const latest = revisions.at(-1);
  assert.ok(latest?.snapshotId);
  assert.ok(latest.previousSnapshotId);

  const registeredCommands = await vscode.commands.getCommands(true);
  assert.ok(registeredCommands.includes("planTracker.compareWithPrevious"));
  assert.ok(registeredCommands.includes("planTracker.compareWithCurrent"));

  void vscode.commands.executeCommand("planTracker.compareWithPrevious", latest.id);
  const previousDiff = await waitForDiffTab();
  assert.equal(previousDiff.original.scheme, "plan-tracker-snapshot");
  assert.equal(previousDiff.modified.scheme, "plan-tracker-snapshot");
  const beforeDocument = await vscode.workspace.openTextDocument(previousDiff.original);
  const afterDocument = await vscode.workspace.openTextDocument(previousDiff.modified);
  assert.equal(beforeDocument.getText(), await api.readSnapshot(latest.previousSnapshotId));
  assert.equal(afterDocument.getText(), "after restart\n");
  assert.equal(afterDocument.isDirty, false);

  void vscode.commands.executeCommand("planTracker.compareWithCurrent", latest.id);
  const currentDiff = await waitForDiffTab("file");
  assert.equal(currentDiff.original.scheme, "plan-tracker-snapshot");
  assert.equal(currentDiff.modified.scheme, "file");
  assert.equal(currentDiff.modified.fsPath, vscode.Uri.joinPath(folder.uri, "baseline.md").fsPath);
}

async function runCapturePhase(folder: vscode.WorkspaceFolder, api: PlanTrackerApi): Promise<void> {
  const baselinePath = `${folder.name}/baseline.md`;
  const excludedPath = `${folder.name}/node_modules/excluded.md`;
  await waitFor(() => api.getHistoryIndex().heads[baselinePath]?.deleted === false);
  assert.equal(api.getHistoryIndex().heads[excludedPath], undefined);

  const baselineUri = vscode.Uri.joinPath(folder.uri, "baseline.md");
  const states = ["first edit\n", "", "Unicode: cafÃ© æ—¥æœ¬èªž âœ¨\n", `${"large line\n".repeat(100_000)}`];
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

async function runRestartPhase(folder: vscode.WorkspaceFolder, api: PlanTrackerApi): Promise<void> {
  const baselinePath = `${folder.name}/baseline.md`;
  const revisionsBeforeEdit = revisionsFor(api, baselinePath);
  assert.equal(revisionsBeforeEdit.length, 5, "all baseline and saved states must survive restart");

  const expectedStates = ["baseline\n", "first edit\n", "", "Unicode: cafÃ© æ—¥æœ¬èªž âœ¨\n"];
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

function revisionsFor(api: PlanTrackerApi, relativePath: string): ReturnType<PlanTrackerApi["getHistoryIndex"]>["revisions"] {
  return api.getHistoryIndex().revisions.filter((revision) => revision.relativePath === relativePath);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > TIMEOUT_MS) {
      assert.fail("Timed out waiting for Plan Tracker history capture");
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
