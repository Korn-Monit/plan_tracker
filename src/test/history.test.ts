import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HISTORY_SCHEMA_VERSION, SnapshotStore, hashContent } from "../history";

async function withStore(run: (store: SnapshotStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "plan-tracker-test-"));
  try {
    const store = new SnapshotStore(root);
    await store.initialize();
    await run(store, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test("stores ordered distinct snapshots and suppresses duplicates", async () => {
  await withStore(async (store) => {
    const baseline = await store.recordContent("workspace/plan.md", "one", "baseline");
    const duplicate = await store.recordContent("workspace/plan.md", "one", "edited");
    const edit = await store.recordContent("workspace/plan.md", "two âœ¨", "edited");

    assert.equal(duplicate, undefined);
    assert.equal(baseline?.kind, "baseline");
    assert.equal(edit?.previousSnapshotId, hashContent("one"));
    assert.equal(store.getIndex().revisions.length, 2);
    assert.equal(await store.readSnapshot(hashContent("two âœ¨")), "two âœ¨");
  });
});

void test("retains empty, deleted, recreated, and renamed file states", async () => {
  await withStore(async (store) => {
    await store.recordContent("workspace/a.md", "", "baseline");
    await store.recordDeletion("workspace/a.md");
    const recreated = await store.recordContent("workspace/a.md", "back", "edited");
    const renamed = await store.recordRename("workspace/a.md", "workspace/b.md", "back");

    assert.equal(recreated?.kind, "created");
    assert.equal(renamed?.kind, "renamed");
    assert.equal(store.getHead("workspace/a.md")?.deleted, true);
    assert.equal(store.getHead("workspace/b.md")?.snapshotId, hashContent("back"));
    assert.deepEqual(
      store.getIndex().revisions.map((revision) => revision.kind),
      ["baseline", "deleted", "created", "renamed"],
    );
  });
});

void test("persists schema-versioned history across restart", async () => {
  await withStore(async (store, root) => {
    await store.recordContent("workspace/plan.md", "durable", "baseline");
    const restarted = new SnapshotStore(root);
    await restarted.initialize();

    assert.equal(restarted.getIndex().schemaVersion, HISTORY_SCHEMA_VERSION);
    assert.equal(restarted.getIndex().revisions.length, 1);
    assert.equal(await restarted.readSnapshot(hashContent("durable")), "durable");
  });
});

void test("re-bases a re-included file without manufacturing a revision", async () => {
  await withStore(async (store) => {
    await store.recordContent("workspace/plan.md", "before exclusion", "baseline");
    const revisionCount = store.getIndex().revisions.length;
    await store.rebaseContent("workspace/plan.md", "changed while excluded");
    assert.equal(store.getIndex().revisions.length, revisionCount);
    assert.equal(store.getHead("workspace/plan.md")?.snapshotId, hashContent("changed while excluded"));
    assert.equal(await store.readSnapshot(hashContent("before exclusion")), "before exclusion");
    await store.recordContent("workspace/plan.md", "after re-inclusion", "edited");
    assert.equal(store.getIndex().revisions.length, revisionCount + 1);
  });
});

void test("recovers the last complete index when the primary index is corrupt", async () => {
  await withStore(async (store, root) => {
    await store.recordContent("workspace/plan.md", "first", "baseline");
    await store.recordContent("workspace/plan.md", "second", "edited");
    await writeFile(path.join(root, "history-v2.json"), "{incomplete", "utf8");

    const recovered = new SnapshotStore(root);
    await recovered.initialize();
    assert.equal(recovered.getIndex().revisions.length, 1);
    assert.equal(recovered.getHead("workspace/plan.md")?.snapshotId, hashContent("first"));
    const repaired = JSON.parse(await readFile(path.join(root, "history-v2.json"), "utf8")) as unknown;
    assert.equal(typeof repaired, "object");
  });
});
