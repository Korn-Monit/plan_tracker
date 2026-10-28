import { SnapshotStore } from "./history";

export type AgentEvent =
  | { type: "turnStarted"; provider: "claude-code"; externalSessionId: string; occurredAt: string; promptPreview?: string }
  | { type: "turnEnded"; provider: "claude-code"; externalSessionId: string; occurredAt: string }
  | { type: "sessionEnded"; provider: "claude-code"; externalSessionId: string; occurredAt: string };

export interface AgentAdapter {
  readonly provider: "claude-code";
  adapt(payload: unknown): AgentEvent | undefined;
}

interface ClaudeHookPayload {
  session_id: string;
  hook_event_name: "UserPromptSubmit" | "Stop" | "SessionEnd";
  prompt?: string;
}

/** Converts the documented Claude Code hook payload into provider-neutral events. */
export class ClaudeCodeAdapter implements AgentAdapter {
  public readonly provider = "claude-code" as const;

  public constructor(private readonly storePromptText = false) {}

  public adapt(payload: unknown): AgentEvent | undefined {
    if (!isClaudeHookPayload(payload)) {
      return undefined;
    }
    const common = {
      provider: this.provider,
      externalSessionId: payload.session_id,
      occurredAt: new Date().toISOString(),
    } as const;
    if (payload.hook_event_name === "UserPromptSubmit") {
      return {
        ...common,
        type: "turnStarted",
        ...(this.storePromptText && payload.prompt !== undefined ? { promptPreview: payload.prompt } : {}),
      };
    }
    if (payload.hook_event_name === "Stop") {
      return { ...common, type: "turnEnded" };
    }
    return { ...common, type: "sessionEnded" };
  }
}

export class SessionCoordinator {
  public constructor(
    private readonly store: SnapshotStore,
    private readonly synchronizeFiles: () => Promise<void>,
  ) {}

  public async accept(event: AgentEvent): Promise<void> {
    if (event.type === "turnStarted") {
      await this.synchronizeFiles();
      await this.store.beginChange({
        provider: event.provider,
        externalSessionId: event.externalSessionId,
        startedAt: event.occurredAt,
        promptPreview: event.promptPreview,
      });
      return;
    }

    if (event.type === "turnEnded") {
      await this.synchronizeFiles();
      await this.store.completeChange(event.externalSessionId, event.occurredAt);
      return;
    }

    await this.synchronizeFiles();
    await this.store.interruptChange(event.externalSessionId, event.occurredAt);
  }
}

function isClaudeHookPayload(value: unknown): value is ClaudeHookPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Partial<ClaudeHookPayload>;
  return typeof payload.session_id === "string"
    && payload.session_id.length > 0
    && (payload.hook_event_name === "UserPromptSubmit"
      || payload.hook_event_name === "Stop"
      || payload.hook_event_name === "SessionEnd")
    && (payload.prompt === undefined || typeof payload.prompt === "string");
}
