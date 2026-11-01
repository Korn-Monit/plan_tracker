import { HistoryIndex } from "./history";

/** Produces the non-destructive, scope-filtered model rendered by the normal History view. */
export function filterHistoryIndex(
  index: Readonly<HistoryIndex>,
  includesPath: (storedPath: string) => boolean,
): HistoryIndex {
  const heads = Object.fromEntries(Object.entries(index.heads).filter(([storedPath]) => includesPath(storedPath)));
  const revisions = index.revisions.filter((revision) => includesPath(revision.relativePath));
  const changes = index.changes
    .map((change) => ({ ...change, files: change.files.filter((file) => includesPath(file.relativePath)) }))
    .filter((change) => change.files.length > 0);
  return { schemaVersion: index.schemaVersion, heads, revisions, changes };
}
