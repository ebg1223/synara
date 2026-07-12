import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  type ChatAttachment,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OmpAdapter, type OmpAdapterShape } from "../Services/OmpAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { clampUsagePercent, nonNegativeFiniteNumber, positiveFiniteNumber } from "../tokenUsage.ts";
import { OmpRpcClient, type OmpRpcExitInfo, type OmpRpcProtocolWarning } from "../ompRpcClient.ts";
import type {
  AgentSessionEvent,
  ImageContent,
  Model,
  OmpRpcFrame,
  RpcAvailableSlashCommand,
  RpcExtensionUIRequest,
  RpcResponse,
  RpcSessionState,
  ThinkingLevel,
  TodoPhase,
} from "../ompRpcTypes.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "omp" as const;
const DEFAULT_BINARY_PATH = "omp";
const DEFAULT_OMP_THINKING_LEVEL: OmpReasoningEffort = "medium";
const MODEL_CACHE_TTL_MS = 30_000;
const OMP_REASONING_OPTIONS = [
  { value: "off", label: "Off", description: "No extra reasoning" },
  { value: "minimal", label: "Minimal", description: "Light reasoning" },
  { value: "low", label: "Low", description: "Faster reasoning" },
  { value: "medium", label: "Medium", description: "Balanced reasoning" },
  { value: "high", label: "High", description: "Deeper reasoning" },
  { value: "xhigh", label: "Extra High", description: "Maximum reasoning" },
] as const;

type OmpReasoningEffort = Exclude<ThinkingLevel, "inherit">;

interface OmpTrackedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly itemId: RuntimeItemId;
  readonly itemType: ToolLifecycleItemType;
  // Dedupe/throttle state for streamed partial results: omp polls (e.g. the
  // `job` wait tool) re-emit identical snapshots every ~500ms, and every
  // forwarded item.updated becomes a persisted activity row plus a WS push.
  lastPartialSignature?: string;
  lastPartialEmittedAtMs?: number;
}

const TOOL_PARTIAL_UPDATE_MIN_INTERVAL_MS = 1_500;

// Same shape for subagent progress frames: omp batches them upstream (~150ms),
// which still floods the activity log during long-running subagents.
interface OmpSubagentProgressMark {
  readonly signature: string;
  readonly emittedAtMs: number;
}

function toolPartialSignature(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

interface OmpPendingApproval {
  readonly rpcId: string;
  readonly requestId: ApprovalRequestId;
  readonly requestType:
    | "command_execution_approval"
    | "file_read_approval"
    | "file_change_approval"
    | "unknown";
}

interface OmpPendingUserInput {
  readonly rpcId: string;
  readonly requestId: ApprovalRequestId;
  readonly questionId: string;
}

interface OmpStoredTurn {
  readonly id: TurnId;
  readonly items: unknown[];
}

interface OmpSessionContext {
  client: OmpRpcClient;
  session: ProviderSession;
  turns: OmpStoredTurn[];
  activeTurnId: TurnId | undefined;
  activeAssistantItemId: RuntimeItemId | undefined;
  activeReasoningItemId: RuntimeItemId | undefined;
  activeToolItems: Map<string, OmpTrackedToolCall>;
  subagentProgressMarks: Map<string, OmpSubagentProgressMark>;
  pendingApprovals: Map<ApprovalRequestId, OmpPendingApproval>;
  pendingApprovalsByRpcId: Map<string, ApprovalRequestId>;
  pendingUserInputs: Map<ApprovalRequestId, OmpPendingUserInput>;
  pendingUserInputsByRpcId: Map<string, ApprovalRequestId>;
  warnedFrameTypes: Set<string>;
  lastKnownModelId: string | undefined;
  lastKnownThinkingLevel: ThinkingLevel | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastKnownCommands: RpcAvailableSlashCommand[] | undefined;
  providerThreadId: string | undefined;
  abortRequested: boolean;
  stopped: boolean;
  /** Serializes get_state refreshes so stale responses cannot clobber newer state. */
  stateRefreshChain: Promise<void>;
}

export interface OmpAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface OmpFrameMappingContext {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly activeAssistantItemId?: RuntimeItemId | undefined;
  readonly activeReasoningItemId?: RuntimeItemId | undefined;
  readonly activeToolItems?: ReadonlyMap<string, OmpTrackedToolCall> | undefined;
  readonly subagentProgressMarks?: ReadonlyMap<string, OmpSubagentProgressMark> | undefined;
  readonly lastKnownModelId?: string | undefined;
  readonly lastKnownThinkingLevel?: ThinkingLevel | undefined;
  readonly abortRequested?: boolean | undefined;
}

export interface OmpFrameMappingResult {
  readonly events: ProviderRuntimeEvent[];
  readonly activeAssistantItemId: RuntimeItemId | undefined;
  readonly activeReasoningItemId: RuntimeItemId | undefined;
  readonly activeToolItems: Map<string, OmpTrackedToolCall>;
  readonly subagentProgressMarks: Map<string, OmpSubagentProgressMark>;
  readonly turnCompleted?: boolean | undefined;
}

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (typeof cause === "string" && cause.trim().length > 0) return cause;
  return fallback;
}

function runtimeErrorDetail(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack ? { stack: cause.stack } : {}),
    };
  }
  return cause;
}

function extractResumeSessionFile(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string" && resumeCursor.trim().length > 0) return resumeCursor;
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const record = resumeCursor as Record<string, unknown>;
  for (const key of ["sessionFile", "sessionFilePath", "nativeHandle", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function parseModelReference(
  model: string | null | undefined,
): { readonly provider: string; readonly modelId: string } | undefined {
  const trimmed = trimToUndefined(model);
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function normalizeThinkingLevel(value: string | null | undefined): OmpReasoningEffort | undefined {
  return value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

function modelSlug(model: Model | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function makeRaw(frame: OmpRpcFrame | AgentSessionEvent) {
  return {
    source: "omp.rpc.event" as const,
    messageType: frame.type,
    payload: frame,
  };
}

function makeBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: RuntimeItemId | undefined;
  readonly requestId?: RuntimeRequestId | undefined;
  readonly providerRefs?: ProviderRuntimeEvent["providerRefs"] | undefined;
  readonly frame?: OmpRpcFrame | AgentSessionEvent | undefined;
}): Pick<
  ProviderRuntimeEvent,
  | "eventId"
  | "provider"
  | "threadId"
  | "createdAt"
  | "turnId"
  | "itemId"
  | "requestId"
  | "providerRefs"
  | "raw"
> {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: new Date().toISOString(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.providerRefs ? { providerRefs: input.providerRefs } : {}),
    ...(input.frame ? { raw: makeRaw(input.frame) } : {}),
  };
}

function nonEmptyDetail(value: unknown): string | undefined {
  if (typeof value === "string") return trimToUndefined(value);
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstStringValue(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function toolCommand(args: unknown): string | undefined {
  return firstStringValue(toolRecord(args), ["command", "cmd"]);
}

function toolPath(args: unknown): string | undefined {
  return firstStringValue(toolRecord(args), ["path", "filePath", "file", "relativePath"]);
}

function toolSearchQuery(toolName: string, args: unknown): string | undefined {
  const record = toolRecord(args);
  if (!record) return undefined;
  if (toolName === "grep" || toolName === "find")
    return firstStringValue(record, ["pattern", "query"]);
  return firstStringValue(record, ["query", "pattern"]);
}

function textFromToolResult(result: unknown): string | undefined {
  if (typeof result === "string") return trimToUndefined(result);
  const record = toolRecord(result);
  const direct = firstStringValue(record, [
    "output",
    "stdout",
    "stderr",
    "text",
    "summary",
    "message",
    "error",
  ]);
  if (direct) return direct;
  const content = Array.isArray(record?.content) ? record.content : [];
  const textParts = content.flatMap((entry) => {
    const entryRecord = toolRecord(entry);
    return entryRecord?.type === "text" && typeof entryRecord.text === "string"
      ? [entryRecord.text]
      : [];
  });
  return trimToUndefined(textParts.join("\n"));
}

export function ompToolItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized === "task" ||
    normalized.includes("subagent") ||
    normalized.includes("subtask") ||
    normalized.includes("agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (
    normalized.includes("web") ||
    normalized.includes("fetch") ||
    normalized.includes("grep") ||
    normalized.includes("find")
  ) {
    return "web_search";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function toolTitle(toolName: string, args: unknown, intent?: string): string {
  const normalizedIntent = trimToUndefined(intent);
  if (normalizedIntent) return normalizedIntent;
  const command = toolName.toLowerCase().includes("bash") ? toolCommand(args) : undefined;
  if (command) return command;
  const path = toolPath(args);
  if (path) return `${toolName} ${path}`;
  const query = toolSearchQuery(toolName, args);
  if (query) return `${toolName} ${query}`;
  return toolName;
}

function toolLifecycleData(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly partialResult?: unknown;
  readonly isError?: boolean | undefined;
}): Record<string, unknown> {
  return {
    toolCallId: input.toolCallId,
    callId: input.toolCallId,
    toolName: input.toolName,
    name: input.toolName,
    tool: input.toolName,
    kind: input.toolName,
    args: input.args,
    input: input.args,
    rawInput: input.args,
    ...(input.result !== undefined ? { result: input.result, rawOutput: input.result } : {}),
    ...(input.partialResult !== undefined
      ? { partialResult: input.partialResult, rawOutput: input.partialResult }
      : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
  };
}

function normalizeUsage(
  contextUsage: RpcSessionState["contextUsage"],
): ThreadTokenUsageSnapshot | undefined {
  const tokens = nonNegativeFiniteNumber(contextUsage?.tokens);
  const max = positiveFiniteNumber(contextUsage?.contextWindow);
  const percent = clampUsagePercent(contextUsage?.percent);
  const usedTokens =
    tokens !== undefined
      ? Math.round(tokens)
      : percent !== undefined && max !== undefined
        ? Math.round((percent / 100) * max)
        : undefined;
  if (usedTokens === undefined && max === undefined && percent === undefined) return undefined;
  return {
    usedTokens: usedTokens ?? 0,
    ...(max !== undefined ? { maxTokens: Math.floor(max) } : {}),
    ...(percent !== undefined ? { usedPercent: percent } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
  };
}

function flattenTasks(phases: ReadonlyArray<TodoPhase>) {
  return phases.flatMap((phase) =>
    phase.tasks.flatMap((task) => {
      const taskText = trimToUndefined(task.content);
      if (!taskText) return [];
      return [
        {
          task: taskText,
          status:
            task.status === "in_progress"
              ? ("inProgress" as const)
              : task.status === "completed"
                ? ("completed" as const)
                : ("pending" as const),
        },
      ];
    }),
  );
}

function runtimeWarning(
  ctx: OmpFrameMappingContext,
  frame: OmpRpcFrame | AgentSessionEvent,
  message: string,
  detail?: unknown,
): ProviderRuntimeEvent {
  return {
    ...makeBase({ threadId: ctx.threadId, turnId: ctx.turnId, frame }),
    type: "runtime.warning",
    payload: { message, ...(detail !== undefined ? { detail } : {}) },
  } satisfies ProviderRuntimeEvent;
}

function completeOpenMessageItems(
  ctx: OmpFrameMappingContext,
  frame: OmpRpcFrame | AgentSessionEvent,
  status: "completed" | "failed",
): ProviderRuntimeEvent[] {
  const events: ProviderRuntimeEvent[] = [];
  if (ctx.activeAssistantItemId) {
    events.push({
      ...makeBase({
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        itemId: ctx.activeAssistantItemId,
        frame,
      }),
      type: "item.completed",
      payload: { itemType: "assistant_message", status, title: "Assistant" },
    } satisfies ProviderRuntimeEvent);
  }
  if (ctx.activeReasoningItemId) {
    events.push({
      ...makeBase({
        threadId: ctx.threadId,
        turnId: ctx.turnId,
        itemId: ctx.activeReasoningItemId,
        frame,
      }),
      type: "item.completed",
      payload: { itemType: "reasoning", status, title: "Reasoning" },
    } satisfies ProviderRuntimeEvent);
  }
  return events;
}

export function mapOmpFrameToRuntimeEvents(
  ctx: OmpFrameMappingContext,
  frame: OmpRpcFrame,
): OmpFrameMappingResult {
  const events: ProviderRuntimeEvent[] = [];
  let activeAssistantItemId = ctx.activeAssistantItemId;
  let activeReasoningItemId = ctx.activeReasoningItemId;
  const activeToolItems = new Map(ctx.activeToolItems ?? []);
  const subagentProgressMarks = new Map(ctx.subagentProgressMarks ?? []);
  const turnId = ctx.turnId;

  switch (frame.type) {
    case "agent_start":
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId, frame }),
        type: "thread.state.changed",
        payload: { state: "active" },
      } satisfies ProviderRuntimeEvent);
      break;
    case "turn_start":
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId, frame }),
        type: "turn.started",
        payload: {
          ...(ctx.lastKnownModelId ? { model: ctx.lastKnownModelId } : {}),
          ...(ctx.lastKnownThinkingLevel ? { effort: ctx.lastKnownThinkingLevel } : {}),
        },
      } satisfies ProviderRuntimeEvent);
      break;
    case "message_update": {
      // Wire types are vendored, not validated: guard the fields this handler
      // dereferences so upstream drift degrades instead of throwing.
      if (frame.message?.role !== "assistant") break;
      const update = frame.assistantMessageEvent;
      if (update === undefined) break;
      if (update.type === "text_start" || update.type === "text_delta") {
        if (!activeAssistantItemId) {
          activeAssistantItemId = RuntimeItemId.makeUnsafe(`omp-assistant-${crypto.randomUUID()}`);
          events.push({
            ...makeBase({ threadId: ctx.threadId, turnId, itemId: activeAssistantItemId, frame }),
            type: "item.started",
            payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
          } satisfies ProviderRuntimeEvent);
        }
        if (update.type === "text_delta") {
          events.push({
            ...makeBase({ threadId: ctx.threadId, turnId, itemId: activeAssistantItemId, frame }),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: update.delta,
              contentIndex: update.contentIndex,
            },
          } satisfies ProviderRuntimeEvent);
        }
        break;
      }
      if (update.type === "thinking_start" || update.type === "thinking_delta") {
        if (!activeReasoningItemId) {
          activeReasoningItemId = RuntimeItemId.makeUnsafe(`omp-reasoning-${crypto.randomUUID()}`);
          events.push({
            ...makeBase({ threadId: ctx.threadId, turnId, itemId: activeReasoningItemId, frame }),
            type: "item.started",
            payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
          } satisfies ProviderRuntimeEvent);
        }
        if (update.type === "thinking_delta") {
          events.push({
            ...makeBase({ threadId: ctx.threadId, turnId, itemId: activeReasoningItemId, frame }),
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: update.delta,
              contentIndex: update.contentIndex,
            },
          } satisfies ProviderRuntimeEvent);
        }
        break;
      }
      if (update.type === "text_end" && activeAssistantItemId) {
        events.push({
          ...makeBase({ threadId: ctx.threadId, turnId, itemId: activeAssistantItemId, frame }),
          type: "item.updated",
          payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
        } satisfies ProviderRuntimeEvent);
      }
      if (update.type === "thinking_end" && activeReasoningItemId) {
        events.push({
          ...makeBase({ threadId: ctx.threadId, turnId, itemId: activeReasoningItemId, frame }),
          type: "item.updated",
          payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
        } satisfies ProviderRuntimeEvent);
      }
      break;
    }
    case "tool_execution_start": {
      const itemId = RuntimeItemId.makeUnsafe(`omp-tool-${frame.toolCallId}`);
      const itemType = ompToolItemType(frame.toolName);
      activeToolItems.set(frame.toolCallId, {
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        args: frame.args,
        itemId,
        itemType,
      });
      events.push({
        ...makeBase({
          threadId: ctx.threadId,
          turnId,
          itemId,
          providerRefs: { providerItemId: ProviderItemId.makeUnsafe(frame.toolCallId) },
          frame,
        }),
        type: "item.started",
        payload: {
          itemType,
          status: "inProgress",
          title: toolTitle(frame.toolName, frame.args, frame.intent),
          data: toolLifecycleData({
            toolCallId: frame.toolCallId,
            toolName: frame.toolName,
            args: frame.args,
          }),
        },
      } satisfies ProviderRuntimeEvent);
      break;
    }
    case "tool_execution_update": {
      const tracked = activeToolItems.get(frame.toolCallId);
      if (!tracked) break;
      // Skip identical snapshots outright, and cap changed ones to one per
      // interval. The final result always flows through tool_execution_end,
      // so dropped ticks lose nothing durable.
      const signature = toolPartialSignature(frame.partialResult);
      const nowMs = Date.now();
      if (
        tracked.lastPartialEmittedAtMs !== undefined &&
        (signature === tracked.lastPartialSignature ||
          nowMs - tracked.lastPartialEmittedAtMs < TOOL_PARTIAL_UPDATE_MIN_INTERVAL_MS)
      ) {
        break;
      }
      tracked.lastPartialSignature = signature;
      tracked.lastPartialEmittedAtMs = nowMs;
      const detail = textFromToolResult(frame.partialResult);
      events.push({
        ...makeBase({
          threadId: ctx.threadId,
          turnId,
          itemId: tracked.itemId,
          providerRefs: { providerItemId: ProviderItemId.makeUnsafe(frame.toolCallId) },
          frame,
        }),
        type: "item.updated",
        payload: {
          itemType: tracked.itemType,
          status: "inProgress",
          title: toolTitle(frame.toolName, tracked.args),
          ...(detail ? { detail } : {}),
          data: toolLifecycleData({
            toolCallId: frame.toolCallId,
            toolName: frame.toolName,
            args: tracked.args,
            partialResult: frame.partialResult,
          }),
        },
      } satisfies ProviderRuntimeEvent);
      break;
    }
    case "tool_execution_end": {
      const tracked = activeToolItems.get(frame.toolCallId) ?? {
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        args: undefined,
        itemId: RuntimeItemId.makeUnsafe(`omp-tool-${frame.toolCallId}`),
        itemType: ompToolItemType(frame.toolName),
      };
      activeToolItems.delete(frame.toolCallId);
      const detail = textFromToolResult(frame.result);
      events.push({
        ...makeBase({
          threadId: ctx.threadId,
          turnId,
          itemId: tracked.itemId,
          providerRefs: { providerItemId: ProviderItemId.makeUnsafe(frame.toolCallId) },
          frame,
        }),
        type: "item.completed",
        payload: {
          itemType: tracked.itemType,
          status: frame.isError ? "failed" : "completed",
          title: toolTitle(frame.toolName, tracked.args),
          ...(detail ? { detail } : {}),
          data: toolLifecycleData({
            toolCallId: frame.toolCallId,
            toolName: frame.toolName,
            args: tracked.args,
            result: frame.result,
            ...(frame.isError !== undefined ? { isError: frame.isError } : {}),
          }),
        },
      } satisfies ProviderRuntimeEvent);
      break;
    }
    case "agent_end":
      events.push(...completeOpenMessageItems(ctx, frame, "completed"));
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId, frame }),
        type: "turn.completed",
        payload: { state: ctx.abortRequested ? "interrupted" : "completed", stopReason: null },
      } satisfies ProviderRuntimeEvent);
      activeAssistantItemId = undefined;
      activeReasoningItemId = undefined;
      activeToolItems.clear();
      subagentProgressMarks.clear();
      return {
        events,
        activeAssistantItemId,
        activeReasoningItemId,
        activeToolItems,
        subagentProgressMarks,
        turnCompleted: true,
      };
    case "auto_compaction_start": {
      const itemId = RuntimeItemId.makeUnsafe(`omp-compaction-${crypto.randomUUID()}`);
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId, itemId, frame }),
        type: "item.started",
        payload: {
          itemType: "context_compaction",
          status: "inProgress",
          title: "Compacting context",
        },
      } satisfies ProviderRuntimeEvent);
      break;
    }
    case "auto_compaction_end": {
      const itemId = RuntimeItemId.makeUnsafe(`omp-compaction-${crypto.randomUUID()}`);
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId, itemId, frame }),
        type: "item.completed",
        payload: {
          itemType: "context_compaction",
          status: frame.errorMessage && !frame.skipped ? "failed" : "completed",
          title: "Context compacted",
          data: frame,
        },
      } satisfies ProviderRuntimeEvent);
      break;
    }
    case "auto_retry_start":
      events.push(
        runtimeWarning(
          ctx,
          frame,
          `Retrying (attempt ${frame.attempt}/${frame.maxAttempts}): ${frame.errorMessage}`,
          frame,
        ),
      );
      break;
    case "auto_retry_end":
      if (!frame.success) {
        events.push(runtimeWarning(ctx, frame, frame.finalError ?? "Retry failed.", frame));
      }
      break;
    case "notice":
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId, frame }),
        type: frame.level === "error" ? "runtime.error" : "runtime.warning",
        payload:
          frame.level === "error"
            ? { message: frame.message, detail: frame }
            : { message: frame.message, detail: frame },
      } satisfies ProviderRuntimeEvent);
      break;
    case "thinking_level_changed":
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId: undefined, frame }),
        type: "session.configured",
        payload: {
          config: { ...(frame.thinkingLevel ? { thinkingLevel: frame.thinkingLevel } : {}) },
        },
      } satisfies ProviderRuntimeEvent);
      break;
    case "subagent_lifecycle": {
      const payload = frame.payload;
      if (typeof payload?.id !== "string") break;
      const providerRefs = payload.parentToolCallId
        ? { providerItemId: ProviderItemId.makeUnsafe(payload.parentToolCallId) }
        : undefined;
      if (payload.status === "started") {
        events.push({
          ...makeBase({ threadId: ctx.threadId, turnId, providerRefs, frame }),
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(payload.id),
            description: trimToUndefined(payload.description) ?? payload.agent,
            taskType: "subagent",
          },
        } satisfies ProviderRuntimeEvent);
      } else {
        subagentProgressMarks.delete(payload.id);
        events.push({
          ...makeBase({ threadId: ctx.threadId, turnId, providerRefs, frame }),
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(payload.id),
            status:
              payload.status === "completed"
                ? "completed"
                : payload.status === "aborted"
                  ? "stopped"
                  : "failed",
          },
        } satisfies ProviderRuntimeEvent);
      }
      break;
    }
    case "subagent_progress": {
      const progress = frame.payload?.progress;
      if (typeof progress?.id !== "string") break;
      const recentOutput = progress.recentOutput ?? [];
      const summary = trimToUndefined(progress.currentTool) ?? trimToUndefined(recentOutput.at(-1));
      // Rate-limit per subagent: tokens/cost change on nearly every frame, so
      // the interval is the effective cap; identical frames never re-emit.
      const signature = `${progress.status}|${progress.task ?? ""}|${summary ?? ""}|${progress.tokens ?? 0}|${progress.cost ?? 0}`;
      const mark = subagentProgressMarks.get(progress.id);
      const nowMs = Date.now();
      if (
        mark !== undefined &&
        (signature === mark.signature ||
          nowMs - mark.emittedAtMs < TOOL_PARTIAL_UPDATE_MIN_INTERVAL_MS)
      ) {
        break;
      }
      subagentProgressMarks.set(progress.id, { signature, emittedAtMs: nowMs });
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId, frame }),
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.makeUnsafe(progress.id),
          description: trimToUndefined(progress.task) ?? progress.agent,
          ...(summary ? { summary } : {}),
          ...(progress.currentTool ? { lastToolName: progress.currentTool } : {}),
          usage: { tokens: progress.tokens ?? 0, cost: progress.cost ?? 0 },
        },
      } satisfies ProviderRuntimeEvent);
      break;
    }
    case "extension_error":
      events.push(runtimeWarning(ctx, frame, "Oh My Pi extension error.", frame));
      break;
    case "config_update":
      events.push({
        ...makeBase({ threadId: ctx.threadId, frame }),
        type: "session.configured",
        payload: {
          config: {
            ...(frame.model ? { model: modelSlug(frame.model) } : {}),
            ...(frame.thinkingLevel ? { thinkingLevel: frame.thinkingLevel } : {}),
          },
        },
      } satisfies ProviderRuntimeEvent);
      break;
    case "session_info_update":
      if (trimToUndefined(frame.title)) {
        events.push({
          ...makeBase({ threadId: ctx.threadId, frame }),
          type: "thread.metadata.updated",
          payload: { name: trimToUndefined(frame.title) },
        } satisfies ProviderRuntimeEvent);
      }
      break;
    case "command_output": {
      const detail = trimToUndefined(frame.output);
      const itemId = RuntimeItemId.makeUnsafe(`omp-command-output-${crypto.randomUUID()}`);
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId, itemId, frame }),
        type: "item.started",
        payload: {
          itemType: "unknown",
          status: "inProgress",
          title: "Command output",
          ...(detail ? { detail } : {}),
        },
      } satisfies ProviderRuntimeEvent);
      events.push({
        ...makeBase({ threadId: ctx.threadId, turnId, itemId, frame }),
        type: "item.completed",
        payload: {
          itemType: "unknown",
          status: "completed",
          title: "Command output",
          ...(detail ? { detail } : {}),
        },
      } satisfies ProviderRuntimeEvent);
      break;
    }
    default:
      break;
  }

  return {
    events,
    activeAssistantItemId,
    activeReasoningItemId,
    activeToolItems,
    subagentProgressMarks,
  };
}

function isSessionEvent(frame: OmpRpcFrame): frame is AgentSessionEvent {
  return (
    frame.type === "agent_start" ||
    frame.type === "agent_end" ||
    frame.type === "turn_start" ||
    frame.type === "turn_end" ||
    frame.type === "message_start" ||
    frame.type === "message_update" ||
    frame.type === "message_end" ||
    frame.type === "tool_execution_start" ||
    frame.type === "tool_execution_update" ||
    frame.type === "tool_execution_end" ||
    frame.type === "auto_compaction_start" ||
    frame.type === "auto_compaction_end" ||
    frame.type === "auto_retry_start" ||
    frame.type === "auto_retry_end" ||
    frame.type === "notice" ||
    frame.type === "thinking_level_changed" ||
    frame.type === "todo_reminder" ||
    frame.type === "todo_auto_clear" ||
    frame.type === "ttsr_triggered" ||
    frame.type === "irc_message" ||
    frame.type === "goal_updated" ||
    frame.type === "retry_fallback_applied" ||
    frame.type === "retry_fallback_succeeded"
  );
}

function isIgnoredFrameType(type: string): boolean {
  return (
    type === "ready" ||
    type === "subagent_event" ||
    type === "host_tool_call" ||
    type === "host_tool_cancel" ||
    type === "host_uri_request" ||
    type === "host_uri_cancel" ||
    type === "todo_reminder" ||
    type === "todo_auto_clear" ||
    type === "ttsr_triggered" ||
    type === "irc_message" ||
    type === "goal_updated" ||
    type === "retry_fallback_applied" ||
    type === "retry_fallback_succeeded" ||
    type === "message_start" ||
    type === "message_end" ||
    type === "turn_end" ||
    type === "prompt_result"
  );
}

function makeSessionSnapshot(context: OmpSessionContext): ProviderSession {
  return {
    ...context.session,
    status: context.stopped ? "closed" : context.activeTurnId ? "running" : "ready",
    updatedAt: new Date().toISOString(),
    ...(context.activeTurnId ? { activeTurnId: context.activeTurnId } : {}),
  };
}

function sessionFromState(input: {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly state: RpcSessionState;
  readonly existing?: ProviderSession;
}): ProviderSession {
  const now = new Date().toISOString();
  const resumeCursor = input.state.sessionFile ?? input.state.sessionId;
  const model = modelSlug(input.state.model);
  return {
    provider: PROVIDER,
    status: input.state.isStreaming ? "running" : "ready",
    runtimeMode: input.runtimeMode,
    threadId: input.threadId,
    cwd: input.cwd,
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    ...(model ? { model } : {}),
    ...(resumeCursor ? { resumeCursor } : {}),
    ...(input.existing?.lastError ? { lastError: input.existing.lastError } : {}),
  };
}

function resolveBinaryPath(value: string | undefined): string {
  return trimToUndefined(value) ?? DEFAULT_BINARY_PATH;
}

function approvalArgs(runtimeMode: ProviderSession["runtimeMode"]): string[] {
  return runtimeMode === "full-access" ? ["--yolo"] : ["--approval-mode", "always-ask"];
}

function versionWarning(binaryPath: string, versionOutput: string | undefined): string | undefined {
  const version = trimToUndefined(versionOutput) ?? "unknown";
  const match = version.match(/^omp\/(\d+)\.(\d+)\.(\d+)/u);
  if (!match || match[1] !== "16") {
    return `Oh My Pi version ${version} may not match the supported RPC protocol (16.x)`;
  }
  return undefined;
}

function requestTypeFromConfirm(frame: Extract<RpcExtensionUIRequest, { method: "confirm" }>) {
  const text = `${frame.title} ${frame.message}`.toLowerCase();
  if (text.includes("read")) return "file_read_approval" as const;
  if (
    text.includes("edit") ||
    text.includes("write") ||
    text.includes("patch") ||
    text.includes("file")
  ) {
    return "file_change_approval" as const;
  }
  if (
    text.includes("bash") ||
    text.includes("command") ||
    text.includes("shell") ||
    text.includes("execute")
  ) {
    return "command_execution_approval" as const;
  }
  return "unknown" as const;
}

function makeQuestionOption(label: string): UserInputQuestion["options"][number] {
  const normalized = trimToUndefined(label) ?? "Option";
  return { label: normalized, description: normalized };
}

function firstAnswer(answers: ProviderUserInputAnswers, questionId: string): string {
  const answer = answers[questionId];
  if (typeof answer === "string") return answer;
  if (Array.isArray(answer)) return answer.find((entry) => typeof entry === "string") ?? "";
  return "";
}

function modelDescriptors(models: ReadonlyArray<Model>): ProviderListModelsResult["models"] {
  return models.map((model) => {
    const supportedReasoningEfforts = model.reasoning
      ? OMP_REASONING_OPTIONS.filter((option) => {
          const mapped = model.thinkingLevelMap?.[option.value];
          return mapped !== null;
        }).map((option) => ({ ...option }))
      : [];
    return {
      slug: `${model.provider}/${model.id}`,
      name: model.name,
      upstreamProviderId: model.provider,
      upstreamProviderName: trimToUndefined(model.providerName) ?? model.provider,
      ...(supportedReasoningEfforts.length > 0
        ? {
            supportedReasoningEfforts,
            ...(supportedReasoningEfforts.some(
              (option) => option.value === DEFAULT_OMP_THINKING_LEVEL,
            )
              ? { defaultReasoningEffort: DEFAULT_OMP_THINKING_LEVEL }
              : {}),
          }
        : {}),
    };
  });
}

function commandDescriptors(
  commands: ReadonlyArray<RpcAvailableSlashCommand>,
): ProviderListCommandsResult["commands"] {
  return commands.map((command) => ({
    name: command.name,
    ...(trimToUndefined(command.description)
      ? { description: trimToUndefined(command.description) }
      : {}),
  }));
}

function makeProviderRequestError(method: string, cause: unknown, fallback: string) {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, fallback),
    cause,
  });
}

export const makeOmpAdapter = (options?: OmpAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OmpSessionContext>();
    const checkedVersions = new Map<string, string | undefined>();
    const modelCache = new Map<string, { result: ProviderListModelsResult; at: number }>();
    const commandCache = new Map<string, ProviderListCommandsResult>();
    const ownsNativeEventLogger = options?.nativeEventLogger === undefined;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) => {
      Effect.runPromise(Queue.offer(runtimeEventQueue, event)).catch(() => undefined);
      if (nativeEventLogger && event.raw) {
        Effect.runPromise(nativeEventLogger.write(event.raw, event.threadId)).catch(
          () => undefined,
        );
      }
    };

    const emitRuntimeError = (
      context: OmpSessionContext,
      message: string,
      method: string,
      detail?: unknown,
    ) => {
      offerRuntimeEvent({
        ...makeBase({ threadId: context.session.threadId, turnId: context.activeTurnId }),
        type: "runtime.error",
        payload: { message, class: "unknown", ...(detail !== undefined ? { detail } : {}) },
        raw: {
          source: "omp.rpc.event",
          messageType: method,
          payload: detail ?? { message },
        },
      } satisfies ProviderRuntimeEvent);
    };

    const updateStateFromGetState = (context: OmpSessionContext) => {
      const refresh = context.stateRefreshChain.then(() => fetchStateUnsafe(context));
      context.stateRefreshChain = refresh.then(
        () => undefined,
        () => undefined,
      );
      return refresh;
    };

    const fetchStateUnsafe = async (context: OmpSessionContext) => {
      const response = await context.client.request<
        Extract<RpcResponse, { command: "get_state"; success: true }>
      >({
        type: "get_state",
      });
      context.providerThreadId = response.data.sessionId;
      context.lastKnownModelId = modelSlug(response.data.model) ?? context.lastKnownModelId;
      context.lastKnownThinkingLevel =
        response.data.thinkingLevel ?? context.lastKnownThinkingLevel;
      context.session = sessionFromState({
        threadId: context.session.threadId,
        cwd: context.session.cwd ?? serverConfig.cwd,
        runtimeMode: context.session.runtimeMode,
        state: response.data,
        existing: context.session,
      });
      const usage = normalizeUsage(response.data.contextUsage);
      context.lastKnownTokenUsage = usage;
      return { state: response.data, usage };
    };

    const completeLocalTurn = (context: OmpSessionContext, frame: OmpRpcFrame) => {
      if (!context.activeTurnId) return;
      const baseTurnId = context.activeTurnId;
      clearStalePending(context, frame);
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
      context.activeToolItems.clear();
      context.activeTurnId = undefined;
      context.abortRequested = false;
      context.session = makeSessionSnapshot(context);
      offerRuntimeEvent({
        ...makeBase({ threadId: context.session.threadId, turnId: baseTurnId, frame }),
        type: "turn.completed",
        payload: { state: "completed", stopReason: null },
      } satisfies ProviderRuntimeEvent);
    };

    const clearStalePending = (
      context: OmpSessionContext,
      frame?: OmpRpcFrame | AgentSessionEvent,
    ) => {
      for (const [requestId, pending] of Array.from(context.pendingApprovals)) {
        context.pendingApprovals.delete(requestId);
        context.pendingApprovalsByRpcId.delete(pending.rpcId);
        offerRuntimeEvent({
          ...makeBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            requestId: RuntimeRequestId.makeUnsafe(requestId),
            frame,
          }),
          type: "request.resolved",
          payload: { requestType: pending.requestType, decision: "cancel" },
        } satisfies ProviderRuntimeEvent);
      }
      for (const [requestId, pending] of Array.from(context.pendingUserInputs)) {
        context.pendingUserInputs.delete(requestId);
        context.pendingUserInputsByRpcId.delete(pending.rpcId);
        offerRuntimeEvent({
          ...makeBase({
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            requestId: RuntimeRequestId.makeUnsafe(requestId),
            frame,
          }),
          type: "user-input.resolved",
          payload: { answers: {} },
        } satisfies ProviderRuntimeEvent);
      }
    };

    const recordItem = (context: OmpSessionContext, item: unknown) => {
      const turn = context.activeTurnId
        ? context.turns.find((candidate) => candidate.id === context.activeTurnId)
        : context.turns.at(-1);
      turn?.items.push(item);
    };

    const applyMappedEvents = (context: OmpSessionContext, frame: OmpRpcFrame) => {
      const result = mapOmpFrameToRuntimeEvents(
        {
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          activeAssistantItemId: context.activeAssistantItemId,
          activeReasoningItemId: context.activeReasoningItemId,
          activeToolItems: context.activeToolItems,
          subagentProgressMarks: context.subagentProgressMarks,
          lastKnownModelId: context.lastKnownModelId,
          lastKnownThinkingLevel: context.lastKnownThinkingLevel,
          abortRequested: context.abortRequested,
        },
        frame,
      );
      context.activeAssistantItemId = result.activeAssistantItemId;
      context.activeReasoningItemId = result.activeReasoningItemId;
      context.activeToolItems = result.activeToolItems;
      context.subagentProgressMarks = result.subagentProgressMarks;

      for (const event of result.events) {
        if (event.type === "turn.completed") {
          const completedTurnId = context.activeTurnId;
          // Terminal events for a turn this adapter no longer tracks (a
          // local-only prompt already completed it, or the process exit path
          // already failed it) must not produce a second turn.completed.
          if (!completedTurnId) continue;
          clearStalePending(context, frame);
          void updateStateFromGetState(context)
            .then(({ usage }) => {
              if (context.activeTurnId !== completedTurnId) return;
              if (usage) {
                offerRuntimeEvent({
                  ...makeBase({
                    threadId: context.session.threadId,
                    turnId: completedTurnId,
                    frame,
                  }),
                  type: "thread.token-usage.updated",
                  payload: { usage },
                } satisfies ProviderRuntimeEvent);
              }
            })
            .catch((cause) => {
              emitRuntimeError(
                context,
                toMessage(cause, "Failed to refresh omp state."),
                "get_state",
                cause,
              );
            })
            .finally(() => {
              // The unexpected-exit path may have terminated this turn while
              // get_state was in flight; emitting here again would duplicate
              // the terminal event.
              if (context.activeTurnId !== completedTurnId) return;
              context.activeTurnId = undefined;
              context.activeAssistantItemId = undefined;
              context.activeReasoningItemId = undefined;
              context.activeToolItems.clear();
              context.abortRequested = false;
              context.session = makeSessionSnapshot(context);
              offerRuntimeEvent(event);
            });
          continue;
        }
        if (event.type === "content.delta") {
          recordItem(context, { type: event.payload.streamKind, delta: event.payload.delta });
        } else if (event.type === "item.completed") {
          recordItem(context, { ...event.payload });
        }
        offerRuntimeEvent(event);
      }
    };

    const handleExtensionUiRequest = (context: OmpSessionContext, frame: RpcExtensionUIRequest) => {
      switch (frame.method) {
        case "confirm": {
          const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
          const requestType = requestTypeFromConfirm(frame);
          context.pendingApprovals.set(requestId, { rpcId: frame.id, requestId, requestType });
          context.pendingApprovalsByRpcId.set(frame.id, requestId);
          offerRuntimeEvent({
            ...makeBase({
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(requestId),
              frame,
            }),
            type: "request.opened",
            payload: {
              requestType,
              detail: `${frame.title}: ${frame.message}`,
              args: { title: frame.title, message: frame.message },
            },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "select": {
          if (!Array.isArray(frame.options)) break;
          const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
          context.pendingUserInputs.set(requestId, {
            rpcId: frame.id,
            requestId,
            questionId: frame.id,
          });
          context.pendingUserInputsByRpcId.set(frame.id, requestId);
          offerRuntimeEvent({
            ...makeBase({
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(requestId),
              frame,
            }),
            type: "user-input.requested",
            payload: {
              questions: [
                {
                  id: frame.id,
                  header: trimToUndefined(frame.title) ?? "Oh My Pi",
                  question: trimToUndefined(frame.title) ?? "Choose an option.",
                  options: frame.options.map(makeQuestionOption),
                  multiSelect: false,
                },
              ],
            },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "input":
        case "editor": {
          const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
          const helper =
            frame.method === "input"
              ? trimToUndefined(frame.placeholder)
              : trimToUndefined(frame.prefill);
          context.pendingUserInputs.set(requestId, {
            rpcId: frame.id,
            requestId,
            questionId: frame.id,
          });
          context.pendingUserInputsByRpcId.set(frame.id, requestId);
          const title = trimToUndefined(frame.title) ?? "Oh My Pi";
          offerRuntimeEvent({
            ...makeBase({
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              requestId: RuntimeRequestId.makeUnsafe(requestId),
              frame,
            }),
            type: "user-input.requested",
            payload: {
              questions: [
                {
                  id: frame.id,
                  header: title,
                  question: helper ? `${title}\n\n${helper}` : title,
                  options: [],
                  multiSelect: false,
                },
              ],
            },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "cancel": {
          const approvalId = context.pendingApprovalsByRpcId.get(frame.targetId);
          if (approvalId) {
            const pending = context.pendingApprovals.get(approvalId);
            context.pendingApprovals.delete(approvalId);
            context.pendingApprovalsByRpcId.delete(frame.targetId);
            offerRuntimeEvent({
              ...makeBase({
                threadId: context.session.threadId,
                turnId: context.activeTurnId,
                requestId: RuntimeRequestId.makeUnsafe(approvalId),
                frame,
              }),
              type: "request.resolved",
              payload: { requestType: pending?.requestType ?? "unknown", decision: "cancel" },
            } satisfies ProviderRuntimeEvent);
          }
          const userInputId = context.pendingUserInputsByRpcId.get(frame.targetId);
          if (userInputId) {
            context.pendingUserInputs.delete(userInputId);
            context.pendingUserInputsByRpcId.delete(frame.targetId);
            offerRuntimeEvent({
              ...makeBase({
                threadId: context.session.threadId,
                turnId: context.activeTurnId,
                requestId: RuntimeRequestId.makeUnsafe(userInputId),
                frame,
              }),
              type: "user-input.resolved",
              payload: { answers: {} },
            } satisfies ProviderRuntimeEvent);
          }
          return;
        }
        case "notify": {
          const message = trimToUndefined(frame.message);
          if (!message) return;
          offerRuntimeEvent({
            ...makeBase({
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              frame,
            }),
            type: frame.notifyType === "error" ? "runtime.error" : "runtime.warning",
            payload:
              frame.notifyType === "error"
                ? { message, detail: frame }
                : { message, detail: frame },
          } satisfies ProviderRuntimeEvent);
          return;
        }
        case "open_url":
          const output = [frame.instructions, frame.launchUrl ?? frame.url].filter(
            (value): value is string => typeof value === "string",
          );
          offerRuntimeEvent({
            ...makeBase({
              threadId: context.session.threadId,
              turnId: context.activeTurnId,
              frame,
            }),
            type: "auth.status",
            payload: { output },
          } satisfies ProviderRuntimeEvent);
          return;
        default:
          return;
      }
    };

    const handleFrame = (context: OmpSessionContext, frame: OmpRpcFrame) => {
      if (frame.type === "available_commands_update") {
        context.lastKnownCommands = frame.commands;
        commandCache.set(context.session.cwd ?? serverConfig.cwd, {
          commands: commandDescriptors(frame.commands),
          source: "omp.rpc.event",
          cached: false,
        });
        return;
      }
      if (frame.type === "prompt_result" && frame.agentInvoked === false) {
        completeLocalTurn(context, frame);
        return;
      }
      if (frame.type === "extension_ui_request") {
        handleExtensionUiRequest(context, frame);
        return;
      }
      if (frame.type === "config_update") {
        context.lastKnownModelId = modelSlug(frame.model) ?? context.lastKnownModelId;
        context.lastKnownThinkingLevel = frame.thinkingLevel ?? context.lastKnownThinkingLevel;
      }
      if (frame.type === "thinking_level_changed") {
        context.lastKnownThinkingLevel = frame.thinkingLevel ?? context.lastKnownThinkingLevel;
      }
      if (
        frame.type === "session_info_update" &&
        frame.sessionId &&
        frame.sessionId !== context.providerThreadId
      ) {
        context.providerThreadId = frame.sessionId;
        void updateStateFromGetState(context).catch((cause) =>
          emitRuntimeError(
            context,
            toMessage(cause, "Failed to refresh omp state."),
            "get_state",
            cause,
          ),
        );
      }
      if (
        frame.type === "tool_execution_end" &&
        (frame.toolName === "todo" || frame.toolName.toLowerCase().includes("todo"))
      ) {
        const todoTurnId = context.activeTurnId;
        void updateStateFromGetState(context)
          .then(({ state }) => {
            offerRuntimeEvent({
              ...makeBase({ threadId: context.session.threadId, turnId: todoTurnId, frame }),
              type: "turn.tasks.updated",
              payload: { tasks: flattenTasks(state.todoPhases) },
            } satisfies ProviderRuntimeEvent);
          })
          .catch((cause) =>
            emitRuntimeError(
              context,
              toMessage(cause, "Failed to refresh omp todos."),
              "get_state",
              cause,
            ),
          );
      }
      if (
        isSessionEvent(frame) ||
        frame.type === "subagent_lifecycle" ||
        frame.type === "subagent_progress" ||
        frame.type === "extension_error" ||
        frame.type === "config_update" ||
        frame.type === "session_info_update" ||
        frame.type === "command_output"
      ) {
        applyMappedEvents(context, frame);
        return;
      }
      if (!isIgnoredFrameType(frame.type) && !context.warnedFrameTypes.has(frame.type)) {
        context.warnedFrameTypes.add(frame.type);
        offerRuntimeEvent({
          ...makeBase({ threadId: context.session.threadId, frame }),
          type: "config.warning",
          payload: { summary: `Unrecognized omp RPC frame type: ${frame.type}` },
        } satisfies ProviderRuntimeEvent);
      }
    };

    const handleProtocolWarning = (context: OmpSessionContext, warning: OmpRpcProtocolWarning) => {
      offerRuntimeEvent({
        ...makeBase({ threadId: context.session.threadId, turnId: context.activeTurnId }),
        type: "runtime.warning",
        payload: {
          message: warning.message,
          ...(warning.detail !== undefined ? { detail: warning.detail } : {}),
        },
        raw: {
          source: "omp.rpc.event",
          messageType: "protocol.warning",
          payload: warning,
        },
      } satisfies ProviderRuntimeEvent);
    };

    const handleUnexpectedExit = (context: OmpSessionContext, exit: OmpRpcExitInfo) => {
      if (exit.requested || context.stopped) return;
      const reason = `omp RPC process exited unexpectedly (${exit.code ?? exit.signal ?? "unknown"}).`;
      context.stopped = true;
      context.session = { ...makeSessionSnapshot(context), status: "closed", lastError: reason };
      offerRuntimeEvent({
        ...makeBase({ threadId: context.session.threadId, turnId: context.activeTurnId }),
        type: "session.exited",
        payload: { reason, exitKind: "error", recoverable: true },
      } satisfies ProviderRuntimeEvent);
      offerRuntimeEvent({
        ...makeBase({ threadId: context.session.threadId, turnId: context.activeTurnId }),
        type: "thread.state.changed",
        payload: { state: "error", detail: { reason } },
      } satisfies ProviderRuntimeEvent);
      // Resolve any approvals/user-inputs the dead process can no longer answer
      // so the UI does not keep prompts open forever.
      clearStalePending(context);
      if (context.activeTurnId) {
        const turnId = context.activeTurnId;
        context.activeTurnId = undefined;
        offerRuntimeEvent({
          ...makeBase({ threadId: context.session.threadId, turnId }),
          type: "turn.completed",
          payload: { state: "failed", errorMessage: reason },
        } satisfies ProviderRuntimeEvent);
      }
      // Drop the dead context so hasSession() reports the truth and
      // ProviderService restarts from the persisted resume cursor instead of
      // adopting a closed session. Mirrors the Codex app-server exit path.
      sessions.delete(context.session.threadId);
    };

    const requireSession = Effect.fn("OmpAdapter.requireSession")(function* (threadId: ThreadId) {
      const context = sessions.get(threadId);
      if (!context)
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      if (context.stopped)
        return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
      return context;
    });

    const disposeSessionContext = async (context: OmpSessionContext) => {
      context.stopped = true;
      clearStalePending(context, { type: "session_info_update" });
      await context.client.stop();
    };

    const buildPromptPayload = (input: {
      readonly input?: string | undefined;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    }) =>
      Effect.gen(function* () {
        const text =
          appendFileAttachmentsPromptBlock({
            text: input.input,
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          }) ?? "";
        const images = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              if (attachment.type !== "image" || !attachment.mimeType) return undefined;
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "turn/start",
                  issue: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem
                .readFile(attachmentPath)
                .pipe(
                  Effect.mapError((cause) =>
                    makeProviderRequestError(
                      "turn/start",
                      cause,
                      "Failed to read attachment file.",
                    ),
                  ),
                );
              return {
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              } satisfies ImageContent;
            }),
          { concurrency: 1 },
        );
        const filteredImages = images.filter((image) => image !== undefined) as ImageContent[];
        return {
          text,
          images: filteredImages,
        };
      });

    const applyModelSelection = async (
      context: OmpSessionContext,
      modelSelection: Parameters<OmpAdapterShape["sendTurn"]>[0]["modelSelection"],
    ) => {
      if (modelSelection?.provider !== "omp") return;
      const parsed = parseModelReference(modelSelection.model);
      if (!parsed) {
        throw new Error(
          `Oh My Pi model '${modelSelection.model}' must be provider-qualified, e.g. 'openai/gpt-5.5'.`,
        );
      }
      await context.client.request({
        type: "set_model",
        provider: parsed.provider,
        modelId: parsed.modelId,
      });
      context.lastKnownModelId = `${parsed.provider}/${parsed.modelId}`;
      const thinkingLevel = normalizeThinkingLevel(modelSelection.options?.thinkingLevel);
      if (thinkingLevel) {
        await context.client.request({ type: "set_thinking_level", level: thinkingLevel });
        context.lastKnownThinkingLevel = thinkingLevel;
      }
      context.session = {
        ...context.session,
        model: context.lastKnownModelId,
        updatedAt: new Date().toISOString(),
      };
    };

    const makeClient = (input: {
      readonly binaryPath: string;
      readonly cwd: string;
      readonly runtimeMode: ProviderSession["runtimeMode"];
      readonly agentDir?: string | undefined;
      readonly contextRef?: { current?: OmpSessionContext } | undefined;
    }) => {
      const clientOptions = {
        binaryPath: input.binaryPath,
        cwd: input.cwd,
        args: approvalArgs(input.runtimeMode),
        ...(input.agentDir ? { env: { PI_CODING_AGENT_DIR: input.agentDir } } : {}),
        onFrame: (frame: OmpRpcFrame) => {
          const context = input.contextRef?.current;
          if (context) handleFrame(context, frame);
        },
        onProtocolWarning: (warning: OmpRpcProtocolWarning) => {
          const context = input.contextRef?.current;
          if (context) handleProtocolWarning(context, warning);
        },
        onExit: (exit: OmpRpcExitInfo) => {
          const context = input.contextRef?.current;
          if (context) handleUnexpectedExit(context, exit);
        },
      };
      return new OmpRpcClient(clientOptions);
    };

    const maybeEmitVersionWarning = (threadId: ThreadId, binaryPath: string) => {
      let warning = checkedVersions.get(binaryPath);
      if (!checkedVersions.has(binaryPath)) {
        const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 4_000 });
        warning = versionWarning(binaryPath, result.stdout || result.stderr);
        checkedVersions.set(binaryPath, warning);
      }
      if (warning) {
        offerRuntimeEvent({
          ...makeBase({ threadId }),
          type: "config.warning",
          payload: { summary: warning },
        } satisfies ProviderRuntimeEvent);
      }
    };

    const startSession: OmpAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
        const binaryPath = resolveBinaryPath(input.providerOptions?.omp?.binaryPath);
        const agentDir = trimToUndefined(input.providerOptions?.omp?.agentDir);
        const existing = sessions.get(input.threadId);
        if (existing) {
          sessions.delete(input.threadId);
          yield* Effect.tryPromise({
            try: () => disposeSessionContext(existing),
            catch: (cause) =>
              makeProviderRequestError(
                "session/restart",
                cause,
                "Failed to stop previous omp session.",
              ),
          });
        }
        maybeEmitVersionWarning(input.threadId, binaryPath);
        const contextRef: { current?: OmpSessionContext } = {};
        const client = makeClient({
          binaryPath,
          cwd,
          runtimeMode: input.runtimeMode,
          ...(agentDir ? { agentDir } : {}),
          contextRef,
        });
        yield* Effect.tryPromise({
          try: () => client.start(),
          catch: (cause) =>
            makeProviderRequestError("session/start", cause, "Failed to start omp RPC session."),
        });
        const provisionalSession: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          cwd,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const context: OmpSessionContext = {
          client,
          session: provisionalSession,
          turns: [],
          activeTurnId: undefined,
          activeAssistantItemId: undefined,
          activeReasoningItemId: undefined,
          activeToolItems: new Map(),
          subagentProgressMarks: new Map(),
          pendingApprovals: new Map(),
          pendingApprovalsByRpcId: new Map(),
          pendingUserInputs: new Map(),
          pendingUserInputsByRpcId: new Map(),
          warnedFrameTypes: new Set(),
          lastKnownModelId: undefined,
          lastKnownThinkingLevel: undefined,
          lastKnownTokenUsage: undefined,
          lastKnownCommands: undefined,
          providerThreadId: undefined,
          abortRequested: false,
          stopped: false,
          stateRefreshChain: Promise.resolve(),
        };
        contextRef.current = context;
        sessions.set(input.threadId, context);
        const resumeSessionFile = extractResumeSessionFile(input.resumeCursor);
        const configureSession = Effect.gen(function* () {
          if (resumeSessionFile) {
            yield* Effect.tryPromise({
              try: () => client.request({ type: "switch_session", sessionPath: resumeSessionFile }),
              catch: (cause) =>
                makeProviderRequestError("session/resume", cause, "Failed to resume omp session."),
            });
          }
          yield* Effect.tryPromise({
            try: async () => {
              await applyModelSelection(context, input.modelSelection);
              await client.request({ type: "set_subagent_subscription", level: "progress" });
              return updateStateFromGetState(context);
            },
            catch: (cause) =>
              makeProviderRequestError(
                "session/configure",
                cause,
                "Failed to configure omp session.",
              ),
          });
        });
        yield* configureSession.pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              sessions.delete(input.threadId);
              yield* Effect.tryPromise({
                try: () => disposeSessionContext(context),
                catch: () => error,
              }).pipe(Effect.catch(() => Effect.void));
              return yield* Effect.fail(error);
            }),
          ),
        );
        offerRuntimeEvent({
          ...makeBase({ threadId: input.threadId }),
          type: "session.started",
          payload: { message: "Oh My Pi session started", resume: context.session.resumeCursor },
        } satisfies ProviderRuntimeEvent);
        offerRuntimeEvent({
          ...makeBase({ threadId: input.threadId }),
          type: "thread.started",
          payload: { providerThreadId: context.providerThreadId },
        } satisfies ProviderRuntimeEvent);
        if (context.lastKnownTokenUsage) {
          offerRuntimeEvent({
            ...makeBase({ threadId: input.threadId }),
            type: "thread.token-usage.updated",
            payload: { usage: context.lastKnownTokenUsage },
          } satisfies ProviderRuntimeEvent);
        }
        return context.session;
      });

    const sendTurn: OmpAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "An Oh My Pi turn is already active for this thread.",
          });
        }
        yield* Effect.tryPromise({
          try: () => applyModelSelection(context, input.modelSelection),
          catch: (cause) =>
            makeProviderRequestError("model/set", cause, "Failed to set Oh My Pi model."),
        });
        const payload = yield* buildPromptPayload(input);
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        context.abortRequested = false;
        context.activeTurnId = turnId;
        context.turns.push({ id: turnId, items: [] });
        context.session = makeSessionSnapshot(context);
        const clearFailedTurn = Effect.sync(() => {
          if (context.activeTurnId === turnId) {
            context.activeTurnId = undefined;
          }
          const turnIndex = context.turns.findIndex((turn) => turn.id === turnId);
          if (turnIndex >= 0) {
            context.turns.splice(turnIndex, 1);
          }
          context.session = makeSessionSnapshot(context);
        });
        const response = yield* Effect.tryPromise({
          try: () =>
            context.client.request<Extract<RpcResponse, { command: "prompt"; success: true }>>({
              type: "prompt",
              message: payload.text,
              ...(payload.images.length > 0 ? { images: payload.images } : {}),
            }),
          catch: (cause) =>
            makeProviderRequestError("prompt", cause, "Failed to send Oh My Pi prompt."),
        }).pipe(Effect.tapError(() => clearFailedTurn));
        if (response.data?.agentInvoked === false) {
          completeLocalTurn(context, response);
        }
        return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
      });

    const steerTurn: NonNullable<OmpAdapterShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const payload = yield* buildPromptPayload(input);
        const createdTurn = !context.activeTurnId;
        const turnId = context.activeTurnId ?? TurnId.makeUnsafe(crypto.randomUUID());
        if (createdTurn) {
          context.activeTurnId = turnId;
          context.turns.push({ id: turnId, items: [] });
        }
        yield* Effect.tryPromise({
          try: () =>
            context.client.request({
              type: "steer",
              message: payload.text,
              ...(payload.images.length > 0 ? { images: payload.images } : {}),
            }),
          catch: (cause) =>
            makeProviderRequestError("turn/steer", cause, "Failed to steer Oh My Pi turn."),
        }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (!createdTurn) return;
              if (context.activeTurnId === turnId) {
                context.activeTurnId = undefined;
              }
              const turnIndex = context.turns.findIndex((turn) => turn.id === turnId);
              if (turnIndex >= 0) {
                context.turns.splice(turnIndex, 1);
              }
            }),
          ),
        );
        return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
      });

    const interruptTurn: OmpAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (context.activeTurnId) {
          context.abortRequested = true;
        }
        // Keep abortRequested set even when the abort RPC errors or times out:
        // omp may have applied the abort without us seeing the response, and a
        // late agent_end must still record the turn as interrupted. Turn
        // start/completion reset the flag, so it cannot leak into later turns.
        yield* Effect.tryPromise({
          try: () => context.client.request({ type: "abort" }),
          catch: (cause) =>
            makeProviderRequestError("turn/interrupt", cause, "Failed to interrupt Oh My Pi turn."),
        });
      });

    const respondToRequest: OmpAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "request/respond",
            detail: `Unknown pending Oh My Pi request: ${requestId}`,
          });
        }
        const response =
          decision === "cancel"
            ? ({ type: "extension_ui_response", id: pending.rpcId, cancelled: true } as const)
            : ({
                type: "extension_ui_response",
                id: pending.rpcId,
                confirmed: decision === "accept" || decision === "acceptForSession",
              } as const);
        // Keep the pending entry until the response is actually written so a
        // transient send failure stays retriable under the same request id.
        yield* Effect.try({
          try: () => context.client.send(response),
          catch: (cause) =>
            makeProviderRequestError(
              "request/respond",
              cause,
              "Failed to send Oh My Pi request response.",
            ),
        });
        context.pendingApprovals.delete(requestId);
        context.pendingApprovalsByRpcId.delete(pending.rpcId);
        offerRuntimeEvent({
          ...makeBase({
            threadId,
            turnId: context.activeTurnId,
            requestId: RuntimeRequestId.makeUnsafe(requestId),
          }),
          type: "request.resolved",
          payload: {
            requestType: pending.requestType,
            decision: decision satisfies ProviderApprovalDecision,
          },
        } satisfies ProviderRuntimeEvent);
      });

    const respondToUserInput: OmpAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input/respond",
            detail: `Unknown pending Oh My Pi user-input request: ${requestId}`,
          });
        }
        // Keep the pending entry until the response is actually written so a
        // transient send failure stays retriable under the same request id.
        yield* Effect.try({
          try: () =>
            context.client.send({
              type: "extension_ui_response",
              id: pending.rpcId,
              value: firstAnswer(answers, pending.questionId),
            }),
          catch: (cause) =>
            makeProviderRequestError(
              "user-input/respond",
              cause,
              "Failed to send Oh My Pi user-input response.",
            ),
        });
        context.pendingUserInputs.delete(requestId);
        context.pendingUserInputsByRpcId.delete(pending.rpcId);
        offerRuntimeEvent({
          ...makeBase({
            threadId,
            turnId: context.activeTurnId,
            requestId: RuntimeRequestId.makeUnsafe(requestId),
          }),
          type: "user-input.resolved",
          payload: { answers },
        } satisfies ProviderRuntimeEvent);
      });

    const stopSession: OmpAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        sessions.delete(threadId);
        // A session whose subprocess already exited was announced via
        // handleUnexpectedExit; stopping it again just drops the bookkeeping.
        if (context.stopped) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => disposeSessionContext(context),
          catch: (cause) =>
            makeProviderRequestError("session/stop", cause, "Failed to stop Oh My Pi session."),
        });
        offerRuntimeEvent({
          ...makeBase({ threadId }),
          type: "thread.state.changed",
          payload: { state: "closed", detail: { reason: "stopped" } },
        } satisfies ProviderRuntimeEvent);
        offerRuntimeEvent({
          ...makeBase({ threadId }),
          type: "session.exited",
          payload: { reason: "stopped", exitKind: "graceful" },
        } satisfies ProviderRuntimeEvent);
      });

    const listSessions: OmpAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map(makeSessionSnapshot));

    const hasSession: OmpAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OmpAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(
        Effect.map(
          (context): ProviderThreadSnapshot => ({
            threadId,
            ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
            turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
          }),
        ),
      );

    const rollbackThread: OmpAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const response = yield* Effect.tryPromise({
          try: () =>
            context.client.request<
              Extract<RpcResponse, { command: "get_branch_messages"; success: true }>
            >({
              type: "get_branch_messages",
            }),
          catch: (cause) =>
            makeProviderRequestError(
              "thread/rollback",
              cause,
              "Failed to list Oh My Pi branch messages.",
            ),
        });
        const targetIndex = Math.max(0, response.data.messages.length - Math.max(0, numTurns));
        const target = response.data.messages[targetIndex];
        if (!target) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/rollback",
            detail: `Could not resolve an Oh My Pi branch point ${numTurns} turns back.`,
          });
        }
        yield* Effect.tryPromise({
          try: () => context.client.request({ type: "branch", entryId: target.entryId }),
          catch: (cause) =>
            makeProviderRequestError(
              "thread/rollback",
              cause,
              "Failed to branch Oh My Pi session.",
            ),
        });
        const nextLength = Math.max(0, context.turns.length - Math.max(0, numTurns));
        context.turns.splice(nextLength);
        return {
          threadId,
          ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
          turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        } satisfies ProviderThreadSnapshot;
      });

    const compactThread: NonNullable<OmpAdapterShape["compactThread"]> = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const itemId = RuntimeItemId.makeUnsafe(`omp-manual-compaction-${crypto.randomUUID()}`);
        offerRuntimeEvent({
          ...makeBase({ threadId, turnId: context.activeTurnId, itemId }),
          type: "item.started",
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Compacting context",
          },
        } satisfies ProviderRuntimeEvent);
        yield* Effect.tryPromise({
          try: () => context.client.request({ type: "compact" }),
          catch: (cause) =>
            makeProviderRequestError("thread/compact", cause, "Failed to compact Oh My Pi thread."),
        });
        offerRuntimeEvent({
          ...makeBase({ threadId, turnId: context.activeTurnId, itemId }),
          type: "item.completed",
          payload: {
            itemType: "context_compaction",
            status: "completed",
            title: "Context compacted",
          },
        } satisfies ProviderRuntimeEvent);
      });

    const stopAll: OmpAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) => stopSession(threadId), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.asVoid);

    const withDiscoveryClient = async <T>(
      input: {
        readonly cwd?: string | undefined;
        readonly binaryPath?: string | undefined;
        readonly agentDir?: string | undefined;
      },
      operation: (client: OmpRpcClient) => Promise<T>,
    ): Promise<T> => {
      const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
      const live = Array.from(sessions.values()).find(
        (context) => context.session.cwd === cwd && !context.stopped,
      );
      if (live) return operation(live.client);
      const binaryPath = resolveBinaryPath(input.binaryPath);
      const discoveryAgentDir = trimToUndefined(input.agentDir);
      const client = makeClient({
        binaryPath,
        cwd,
        runtimeMode: "approval-required",
        ...(discoveryAgentDir ? { agentDir: discoveryAgentDir } : {}),
      });
      await client.start();
      try {
        return await operation(client);
      } finally {
        await client.stop();
      }
    };

    const listModels: NonNullable<OmpAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const cacheKey = `${trimToUndefined(input.cwd) ?? serverConfig.cwd}\0${resolveBinaryPath(input.binaryPath)}\0${trimToUndefined(input.agentDir) ?? ""}`;
          const cached = modelCache.get(cacheKey);
          if (cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
            return { ...cached.result, cached: true };
          }
          const response = await withDiscoveryClient(input, (client) =>
            client.request<
              Extract<RpcResponse, { command: "get_available_models"; success: true }>
            >({
              type: "get_available_models",
            }),
          );
          const result = {
            models: modelDescriptors(response.data.models),
            source: "omp.rpc",
            cached: false,
          } satisfies ProviderListModelsResult;
          modelCache.set(cacheKey, { result, at: Date.now() });
          return result;
        },
        catch: (cause) =>
          makeProviderRequestError("model/list", cause, "Failed to list Oh My Pi models."),
      });

    const listCommands: NonNullable<OmpAdapterShape["listCommands"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const cacheKey = trimToUndefined(input.cwd) ?? serverConfig.cwd;
          const live = input.threadId
            ? sessions.get(ThreadId.makeUnsafe(input.threadId))
            : undefined;
          if (!input.forceReload && live?.lastKnownCommands) {
            return {
              commands: commandDescriptors(live.lastKnownCommands),
              source: "omp.rpc.event",
              cached: true,
            } satisfies ProviderListCommandsResult;
          }
          if (!input.forceReload) {
            const cached = commandCache.get(cacheKey);
            if (cached) return { ...cached, cached: true };
          }
          const response = await withDiscoveryClient(input, (client) =>
            client.request<
              Extract<RpcResponse, { command: "get_available_commands"; success: true }>
            >({
              type: "get_available_commands",
            }),
          );
          const result = {
            commands: commandDescriptors(response.data.commands),
            source: "omp.rpc",
            cached: false,
          } satisfies ProviderListCommandsResult;
          commandCache.set(cacheKey, result);
          return result;
        },
        catch: (cause) =>
          makeProviderRequestError("command/list", cause, "Failed to list Oh My Pi commands."),
      });

    const getComposerCapabilities: NonNullable<OmpAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: true,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ignore,
        Effect.andThen(
          ownsNativeEventLogger && nativeEventLogger
            ? nativeEventLogger.close().pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsTurnSteering: true,
        supportsRuntimeModelList: true,
        supportsNativeSlashCommandDiscovery: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      compactThread,
      stopAll,
      listModels,
      listCommands,
      getComposerCapabilities,
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies OmpAdapterShape;
  });

export const makeOmpAdapterLive = (options?: OmpAdapterLiveOptions) =>
  Layer.effect(OmpAdapter, makeOmpAdapter(options));

export const OmpAdapterLive = makeOmpAdapterLive();
