import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const HISTORY_SCHEMA_VERSION = 1;

export type RevisionKind = "baseline" | "created" | "edited" | "deleted" | "renamed";

export interface Revision {
  id: string;
  relativePath: string;
  previousPath?: string;
  snapshotId?: string;
  previousSnapshotId?: string;
  recordedAt: string;
  kind: RevisionKind;
}

interface FileHead {
  snapshotId?: string;
  deleted: boolean;
}

export interface HistoryIndex {
  schemaVersion: 1;
  revisions: Revision[];
  heads: Record<string, FileHead>;
}

const EMPTY_INDEX: HistoryIndex = {
  schemaVersion: HISTORY_SCHEMA_VERSION,
  revisions: [],
  heads: {},
};

export class SnapshotStore {
  private readonly indexPath: string;
  private readonly backupPath: string;
  private readonly temporaryPath: string;
  private readonly snapshotsPath: string;
  private index: HistoryIndex = structuredClone(EMPTY_INDEX);
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly changeListeners = new Set<() => void>();

  public constructor(rootPath: string) {
    this.indexPath = path.join(rootPath, "history-v1.json");
    this.backupPath = path.join(rootPath, "history-v1.backup.json");
    this.temporaryPath = path.join(rootPath, "history-v1.pending.json");
    this.snapshotsPath = path.join(rootPath, "snapshots");
  }

  public async initialize(): Promise<void> {
    await mkdir(this.snapshotsPath, { recursive: true });
    const primary = await this.readIndex(this.indexPath);
    if (primary !== undefined) {
      this.index = primary;
      return;
    }

    const backup = await this.readIndex(this.backupPath);
    if (backup !== undefined) {
      this.index = backup;
      await this.persist(false);
      return;
    }

    this.index = structuredClone(EMPTY_INDEX);
    await this.persist();
  }

  public getIndex(): Readonly<HistoryIndex> {
    return structuredClone(this.index);
  }

  public onDidChange(listener: () => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  public getHead(relativePath: string): Readonly<FileHead> | undefined {
    const head = this.index.heads[relativePath];
    return head === undefined ? undefined : { ...head };
  }

  public async readSnapshot(snapshotId: string): Promise<string> {
    return readFile(this.snapshotFile(snapshotId), "utf8");
  }

  public recordContent(
    relativePath: string,
    content: string,
    kind: Exclude<RevisionKind, "deleted" | "renamed">,
  ): Promise<Revision | undefined> {
    return this.enqueue(async () => {
      const snapshotId = hashContent(content);
      const current = this.index.heads[relativePath];
      if (current?.deleted === false && current.snapshotId === snapshotId) {
        return undefined;
      }

      await this.writeSnapshot(snapshotId, content);
      const revision: Revision = {
        id: randomUUID(),
        relativePath,
        snapshotId,
        previousSnapshotId: current?.snapshotId,
        recordedAt: new Date().toISOString(),
        kind: current === undefined ? kind : current.deleted ? "created" : kind,
      };
      this.index.revisions.push(revision);
      this.index.heads[relativePath] = { snapshotId, deleted: false };
      await this.persist();
      this.notifyChanged();
      return revision;
    });
  }

  public recordDeletion(relativePath: string): Promise<Revision | undefined> {
    return this.enqueue(async () => {
      const current = this.index.heads[relativePath];
      if (current === undefined || current.deleted) {
        return undefined;
      }

      const revision: Revision = {
        id: randomUUID(),
        relativePath,
        previousSnapshotId: current.snapshotId,
        recordedAt: new Date().toISOString(),
        kind: "deleted",
      };
      this.index.revisions.push(revision);
      this.index.heads[relativePath] = { snapshotId: current.snapshotId, deleted: true };
      await this.persist();
      this.notifyChanged();
      return revision;
    });
  }

  public recordRename(previousPath: string, relativePath: string, content: string): Promise<Revision | undefined> {
    return this.enqueue(async () => {
      const previous = this.index.heads[previousPath];
      const snapshotId = hashContent(content);
      if (previous === undefined || previous.deleted) {
        return this.recordContentUnlocked(relativePath, content, "created");
      }

      await this.writeSnapshot(snapshotId, content);
      const revision: Revision = {
        id: randomUUID(),
        relativePath,
        previousPath,
        snapshotId,
        previousSnapshotId: previous.snapshotId,
        recordedAt: new Date().toISOString(),
        kind: "renamed",
      };
      this.index.revisions.push(revision);
      this.index.heads[previousPath] = { snapshotId: previous.snapshotId, deleted: true };
      this.index.heads[relativePath] = { snapshotId, deleted: false };
      await this.persist();
      this.notifyChanged();
      return revision;
    });
  }

  private async recordContentUnlocked(relativePath: string, content: string, kind: "created"): Promise<Revision> {
    const snapshotId = hashContent(content);
    await this.writeSnapshot(snapshotId, content);
    const revision: Revision = {
      id: randomUUID(),
      relativePath,
      snapshotId,
      recordedAt: new Date().toISOString(),
      kind,
    };
    this.index.revisions.push(revision);
    this.index.heads[relativePath] = { snapshotId, deleted: false };
    await this.persist();
    this.notifyChanged();
    return revision;
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readIndex(filePath: string): Promise<HistoryIndex | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
      if (!isHistoryIndex(parsed)) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async persist(preserveCurrent = true): Promise<void> {
    const serialized = `${JSON.stringify(this.index, undefined, 2)}\n`;
    if (preserveCurrent) {
      try {
        await stat(this.indexPath);
        await writeFile(this.backupPath, await readFile(this.indexPath));
      } catch {
        // The first write has no previous index to preserve.
      }
    }
    await writeFile(this.temporaryPath, serialized, "utf8");
    await rename(this.temporaryPath, this.indexPath);
  }

  private async writeSnapshot(snapshotId: string, content: string): Promise<void> {
    const destination = this.snapshotFile(snapshotId);
    try {
      await stat(destination);
    } catch {
      const temporary = `${destination}.${randomUUID()}.pending`;
      await writeFile(temporary, content, "utf8");
      try {
        await rename(temporary, destination);
      } catch (error: unknown) {
        try {
          await stat(destination);
        } catch {
          throw error;
        }
      }
    }
  }

  private snapshotFile(snapshotId: string): string {
    return path.join(this.snapshotsPath, `${snapshotId}.md`);
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isHistoryIndex(value: unknown): value is HistoryIndex {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<HistoryIndex>;
  if (candidate.schemaVersion !== HISTORY_SCHEMA_VERSION
    || !Array.isArray(candidate.revisions)
    || !candidate.revisions.every(isRevision)
    || typeof candidate.heads !== "object"
    || candidate.heads === null) {
    return false;
  }
  return Object.values(candidate.heads).every(isFileHead);
}

function isRevision(value: unknown): value is Revision {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const revision = value as Partial<Revision>;
  const kinds: RevisionKind[] = ["baseline", "created", "edited", "deleted", "renamed"];
  return typeof revision.id === "string"
    && typeof revision.relativePath === "string"
    && typeof revision.recordedAt === "string"
    && revision.kind !== undefined
    && kinds.includes(revision.kind)
    && (revision.snapshotId === undefined || typeof revision.snapshotId === "string")
    && (revision.previousSnapshotId === undefined || typeof revision.previousSnapshotId === "string")
    && (revision.previousPath === undefined || typeof revision.previousPath === "string");
}

function isFileHead(value: unknown): value is FileHead {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const head = value as Partial<FileHead>;
  return typeof head.deleted === "boolean"
    && (head.snapshotId === undefined || typeof head.snapshotId === "string");
}
