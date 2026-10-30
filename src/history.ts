import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const HISTORY_SCHEMA_VERSION = 2;

export type RevisionKind = "baseline" | "created" | "edited" | "deleted" | "renamed";

export interface Revision {
  id: string;
  relativePath: string;
  previousPath?: string;
  snapshotId?: string;
  previousSnapshotId?: string;
  recordedAt: string;
  kind: RevisionKind;
  changeId?: string;
}

export type AttributionState = "attributed" | "unassigned" | "ambiguous";

export interface FileChange {
  relativePath: string;
  beforeSnapshotId?: string;
  afterSnapshotId?: string;
}

export interface Change {
  id: string;
  provider: "claude-code" | "unknown";
  externalSessionId?: string;
  startedAt: string;
  endedAt?: string;
  promptPreview?: string;
  files: FileChange[];
  attribution: AttributionState;
  status: "active" | "completed" | "interrupted";
  baselineHeads?: Record<string, FileHead>;
}

interface FileHead {
  snapshotId?: string;
  deleted: boolean;
}

export interface HistoryIndex {
  schemaVersion: 2;
  revisions: Revision[];
  heads: Record<string, FileHead>;
  changes: Change[];
}

export interface RetentionPolicy {
  maxAgeDays: number;
  maxStorageBytes: number;
  now?: Date;
}

export interface RetentionResult {
  removedRevisions: number;
  removedChanges: number;
  removedSnapshots: number;
  storageBytes: number;
  limitSatisfied: boolean;
}

const EMPTY_INDEX: HistoryIndex = {
  schemaVersion: HISTORY_SCHEMA_VERSION,
  revisions: [],
  heads: {},
  changes: [],
};

export class SnapshotStore {
  private readonly indexPath: string;
  private readonly backupPath: string;
  private readonly temporaryPath: string;
  private readonly snapshotsPath: string;
  private index: HistoryIndex = structuredClone(EMPTY_INDEX);
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly changeListeners = new Set<() => void>();
  private recoveryNotice: string | undefined;

  public constructor(rootPath: string) {
    this.indexPath = path.join(rootPath, "history-v2.json");
    this.backupPath = path.join(rootPath, "history-v2.backup.json");
    this.temporaryPath = path.join(rootPath, "history-v2.pending.json");
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
      this.recoveryNotice = "PromptTrace recovered history from its last complete backup because the primary index was unavailable or malformed.";
      await this.persist(false);
      return;
    }

    const legacy = await this.readLegacyIndex(path.join(path.dirname(this.indexPath), "history-v1.json"));
    if (legacy !== undefined) {
      this.index = legacy;
      this.recoveryNotice = "PromptTrace migrated workspace history from schema version 1 to version 2.";
      await this.persist(false);
      return;
    }

    this.index = structuredClone(EMPTY_INDEX);
    await this.persist();
  }

  public getIndex(): Readonly<HistoryIndex> {
    return structuredClone(this.index);
  }

  public getRecoveryNotice(): string | undefined {
    return this.recoveryNotice;
  }

  public applyRetention(policy: RetentionPolicy): Promise<RetentionResult> {
    return this.enqueue(async () => {
      const originalRevisionCount = this.index.revisions.length;
      const originalChangeCount = this.index.changes.length;
      const now = policy.now ?? new Date();
      const cutoff = policy.maxAgeDays > 0
        ? now.getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1000
        : Number.NEGATIVE_INFINITY;
      const protectedRevisionIds = new Set<string>();
      for (const relativePath of Object.keys(this.index.heads)) {
        const latest = [...this.index.revisions].reverse().find((revision) => revision.relativePath === relativePath);
        if (latest !== undefined) {
          protectedRevisionIds.add(latest.id);
        }
      }

      if (policy.maxAgeDays > 0) {
        this.index.revisions = this.index.revisions.filter((revision) => protectedRevisionIds.has(revision.id)
          || timestamp(revision.recordedAt) >= cutoff);
        this.index.changes = this.index.changes.filter((change) => change.status === "active"
          || timestamp(change.endedAt ?? change.startedAt) >= cutoff);
      }
      this.normalizeRetainedHistory();

      let snapshotState = await this.snapshotState();
      while (policy.maxStorageBytes > 0 && snapshotState.bytes > policy.maxStorageBytes) {
        const removableRevision = this.index.revisions.find((revision) => !protectedRevisionIds.has(revision.id));
        const removableChange = this.index.changes.find((change) => change.status !== "active");
        if (removableRevision === undefined && removableChange === undefined) {
          break;
        }
        const revisionTime = removableRevision === undefined ? Number.POSITIVE_INFINITY : timestamp(removableRevision.recordedAt);
        const changeTime = removableChange === undefined
          ? Number.POSITIVE_INFINITY
          : timestamp(removableChange.endedAt ?? removableChange.startedAt);
        if (revisionTime <= changeTime && removableRevision !== undefined) {
          this.index.revisions = this.index.revisions.filter((revision) => revision.id !== removableRevision.id);
        } else if (removableChange !== undefined) {
          this.index.changes = this.index.changes.filter((change) => change.id !== removableChange.id);
        }
        this.normalizeRetainedHistory();
        snapshotState = await this.snapshotState();
      }

      await this.persist();
      const removedSnapshots = await this.removeUnreferencedSnapshots(snapshotState.files);
      const finalState = await this.snapshotState();
      this.notifyChanged();
      return {
        removedRevisions: originalRevisionCount - this.index.revisions.length,
        removedChanges: originalChangeCount - this.index.changes.length,
        removedSnapshots,
        storageBytes: finalState.bytes,
        limitSatisfied: policy.maxStorageBytes <= 0 || finalState.bytes <= policy.maxStorageBytes,
      };
    });
  }

  public clear(): Promise<void> {
    return this.enqueue(async () => {
      await rm(this.snapshotsPath, { recursive: true, force: true });
      await rm(this.indexPath, { force: true });
      await rm(this.backupPath, { force: true });
      await rm(this.temporaryPath, { force: true });
      await mkdir(this.snapshotsPath, { recursive: true });
      this.index = structuredClone(EMPTY_INDEX);
      this.recoveryNotice = undefined;
      await this.persist(false);
      this.notifyChanged();
    });
  }

  public onDidChange(listener: () => void): { dispose(): void } {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  public getHead(relativePath: string): Readonly<FileHead> | undefined {
    const head = this.index.heads[relativePath];
    return head === undefined ? undefined : { ...head };
  }

  public async beginChange(input: {
    provider: "claude-code";
    externalSessionId: string;
    startedAt: string;
    promptPreview?: string;
  }): Promise<Change> {
    return this.enqueue(async () => {
      const active = this.index.changes.find((change) => change.status === "active");
      let attribution: AttributionState = "attributed";
      if (active !== undefined) {
        active.status = "interrupted";
        active.endedAt = input.startedAt;
        active.attribution = "ambiguous";
        active.files = this.fileChanges(active.baselineHeads ?? {});
        delete active.baselineHeads;
        attribution = "ambiguous";
      }
      const change: Change = {
        id: randomUUID(),
        provider: input.provider,
        externalSessionId: input.externalSessionId,
        startedAt: input.startedAt,
        promptPreview: input.promptPreview,
        files: [],
        attribution,
        status: "active",
        baselineHeads: structuredClone(this.index.heads),
      };
      this.index.changes.push(change);
      await this.persist();
      this.notifyChanged();
      return structuredClone(change);
    });
  }

  public async completeChange(externalSessionId: string, endedAt: string): Promise<Change | undefined> {
    return this.finalizeChange(externalSessionId, endedAt, "completed");
  }

  public async interruptChange(externalSessionId: string, endedAt: string): Promise<Change | undefined> {
    return this.finalizeChange(externalSessionId, endedAt, "interrupted");
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
        // Recreate a missing content-addressed file without manufacturing a revision.
        await this.writeSnapshot(snapshotId, content);
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
        changeId: this.activeChange()?.id,
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
        changeId: this.activeChange()?.id,
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
        changeId: this.activeChange()?.id,
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
      changeId: this.activeChange()?.id,
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

  private activeChange(): Change | undefined {
    return this.index.changes.find((change) => change.status === "active");
  }

  private finalizeChange(
    externalSessionId: string,
    endedAt: string,
    status: "completed" | "interrupted",
  ): Promise<Change | undefined> {
    return this.enqueue(async () => {
      const change = this.index.changes.find((candidate) => candidate.status === "active"
        && candidate.externalSessionId === externalSessionId);
      if (change === undefined) {
        return undefined;
      }
      change.endedAt = endedAt;
      change.status = status;
      change.files = this.fileChanges(change.baselineHeads ?? {});
      delete change.baselineHeads;
      await this.persist();
      this.notifyChanged();
      return structuredClone(change);
    });
  }

  private fileChanges(baseline: Record<string, FileHead>): FileChange[] {
    const paths = new Set([...Object.keys(baseline), ...Object.keys(this.index.heads)]);
    return [...paths].sort().flatMap((relativePath) => {
      const before = baseline[relativePath];
      const after = this.index.heads[relativePath];
      const beforeSnapshotId = before?.deleted === false ? before.snapshotId : undefined;
      const afterSnapshotId = after?.deleted === false ? after.snapshotId : undefined;
      if (beforeSnapshotId === afterSnapshotId) {
        return [];
      }
      return [{ relativePath, beforeSnapshotId, afterSnapshotId }];
    });
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

  private async readLegacyIndex(filePath: string): Promise<HistoryIndex | undefined> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
        schemaVersion?: unknown;
        revisions?: unknown;
        heads?: unknown;
      };
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.revisions)
        || !parsed.revisions.every(isRevision) || typeof parsed.heads !== "object" || parsed.heads === null
        || !Object.values(parsed.heads).every(isFileHead)) {
        return undefined;
      }
      return {
        schemaVersion: HISTORY_SCHEMA_VERSION,
        revisions: parsed.revisions,
        heads: parsed.heads as Record<string, FileHead>,
        changes: [],
      };
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

  private normalizeRetainedHistory(): void {
    const changeIds = new Set(this.index.changes.map((change) => change.id));
    const retainedContent = new Set<string>();
    for (const revision of this.index.revisions) {
      if (revision.snapshotId !== undefined) retainedContent.add(revision.snapshotId);
    }
    for (const head of Object.values(this.index.heads)) {
      if (head.snapshotId !== undefined) retainedContent.add(head.snapshotId);
    }
    for (const change of this.index.changes) {
      for (const file of change.files) {
        if (file.beforeSnapshotId !== undefined) retainedContent.add(file.beforeSnapshotId);
        if (file.afterSnapshotId !== undefined) retainedContent.add(file.afterSnapshotId);
      }
    }
    this.index.revisions = this.index.revisions.map((revision) => {
      const normalized = { ...revision };
      if (normalized.previousSnapshotId !== undefined && !retainedContent.has(normalized.previousSnapshotId)) {
        delete normalized.previousSnapshotId;
      }
      if (normalized.changeId !== undefined && !changeIds.has(normalized.changeId)) {
        delete normalized.changeId;
      }
      return normalized;
    });
  }

  private referencedSnapshotIds(): Set<string> {
    const referenced = new Set<string>();
    const add = (value: string | undefined): void => {
      if (value !== undefined) referenced.add(value);
    };
    for (const revision of this.index.revisions) {
      add(revision.snapshotId);
      add(revision.previousSnapshotId);
    }
    for (const head of Object.values(this.index.heads)) add(head.snapshotId);
    for (const change of this.index.changes) {
      for (const file of change.files) {
        add(file.beforeSnapshotId);
        add(file.afterSnapshotId);
      }
      for (const head of Object.values(change.baselineHeads ?? {})) add(head.snapshotId);
    }
    return referenced;
  }

  private async snapshotState(): Promise<{ files: Map<string, number>; bytes: number }> {
    const files = new Map<string, number>();
    const referenced = this.referencedSnapshotIds();
    for (const entry of await readdir(this.snapshotsPath, { withFileTypes: true })) {
      const match = /^([a-f\d]{64})\.md$/u.exec(entry.name);
      if (!entry.isFile() || match?.[1] === undefined || !referenced.has(match[1])) continue;
      files.set(match[1], (await stat(path.join(this.snapshotsPath, entry.name))).size);
    }
    return { files, bytes: [...files.values()].reduce((sum, size) => sum + size, 0) };
  }

  private async removeUnreferencedSnapshots(retainedFiles: Map<string, number>): Promise<number> {
    let removed = 0;
    for (const entry of await readdir(this.snapshotsPath, { withFileTypes: true })) {
      const match = /^([a-f\d]{64})\.md$/u.exec(entry.name);
      if (entry.isFile() && match?.[1] !== undefined && !retainedFiles.has(match[1])) {
        await rm(path.join(this.snapshotsPath, entry.name), { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private snapshotFile(snapshotId: string): string {
    return path.join(this.snapshotsPath, `${snapshotId}.md`);
  }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
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
    || !Array.isArray(candidate.changes)
    || !candidate.changes.every(isChange)
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
    && (revision.previousPath === undefined || typeof revision.previousPath === "string")
    && (revision.changeId === undefined || typeof revision.changeId === "string");
}

function isChange(value: unknown): value is Change {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const change = value as Partial<Change>;
  return typeof change.id === "string"
    && (change.provider === "claude-code" || change.provider === "unknown")
    && typeof change.startedAt === "string"
    && (change.endedAt === undefined || typeof change.endedAt === "string")
    && (change.externalSessionId === undefined || typeof change.externalSessionId === "string")
    && (change.promptPreview === undefined || typeof change.promptPreview === "string")
    && (change.attribution === "attributed" || change.attribution === "unassigned" || change.attribution === "ambiguous")
    && (change.status === "active" || change.status === "completed" || change.status === "interrupted")
    && Array.isArray(change.files)
    && change.files.every((file) => typeof file === "object" && file !== null
      && typeof file.relativePath === "string"
      && (file.beforeSnapshotId === undefined || typeof file.beforeSnapshotId === "string")
      && (file.afterSnapshotId === undefined || typeof file.afterSnapshotId === "string"))
    && (change.baselineHeads === undefined || (typeof change.baselineHeads === "object"
      && change.baselineHeads !== null && Object.values(change.baselineHeads).every(isFileHead)));
}

function isFileHead(value: unknown): value is FileHead {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const head = value as Partial<FileHead>;
  return typeof head.deleted === "boolean"
    && (head.snapshotId === undefined || typeof head.snapshotId === "string");
}
