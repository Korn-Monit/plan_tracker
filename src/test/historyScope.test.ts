import assert from "node:assert/strict";
import test from "node:test";

import { HistoryIndex } from "../history";
import { filterHistoryIndex } from "../historyScope";

void test("History hides excluded retained revisions and filters mixed or empty Changes", () => {
  const index: HistoryIndex = {
    schemaVersion: 2,
    heads: {
      "workspace/included.md": { snapshotId: "included", deleted: false },
      "workspace/private.md": { snapshotId: "private", deleted: false },
    },
    revisions: [
      { id: "included", relativePath: "workspace/included.md", recordedAt: "2026-01-01T00:00:00Z", kind: "edited" },
      { id: "private", relativePath: "workspace/private.md", recordedAt: "2026-01-01T00:00:00Z", kind: "edited" },
    ],
    changes: [
      {
        id: "mixed", provider: "claude-code", startedAt: "2026-01-01T00:00:00Z", files: [
          { relativePath: "workspace/included.md" }, { relativePath: "workspace/private.md" },
        ], attribution: "attributed", status: "completed",
      },
      {
        id: "excluded-only", provider: "claude-code", startedAt: "2026-01-01T00:00:00Z",
        files: [{ relativePath: "workspace/private.md" }], attribution: "attributed", status: "completed",
      },
    ],
  };
  const visible = filterHistoryIndex(index, (path) => !path.endsWith("private.md"));
  assert.deepEqual(visible.revisions.map((revision) => revision.id), ["included"]);
  assert.deepEqual(Object.keys(visible.heads), ["workspace/included.md"]);
  assert.deepEqual(visible.changes.map((change) => change.id), ["mixed"]);
  assert.deepEqual(visible.changes[0]?.files.map((file) => file.relativePath), ["workspace/included.md"]);
  assert.equal(index.revisions.length, 2, "filtering must not delete retained history");
});
