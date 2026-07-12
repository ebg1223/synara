import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  mapOmpFrameToRuntimeEvents,
  ompToolItemType,
  type OmpFrameMappingResult,
} from "./OmpAdapter.ts";
import type { OmpRpcFrame } from "../ompRpcTypes.ts";

const threadId = ThreadId.makeUnsafe("thread-omp-test");
const turnId = TurnId.makeUnsafe("turn-omp-test");

describe("ompToolItemType", () => {
  it("maps Oh My Pi tool names to canonical item types", () => {
    expect(ompToolItemType("task")).toBe("collab_agent_tool_call");
    expect(ompToolItemType("bash")).toBe("command_execution");
    expect(ompToolItemType("shell")).toBe("command_execution");
    expect(ompToolItemType("edit")).toBe("file_change");
    // `read` intentionally mirrors PiAdapter: reads are not file changes.
    expect(ompToolItemType("read")).toBe("dynamic_tool_call");
    expect(ompToolItemType("fetch")).toBe("web_search");
    expect(ompToolItemType("mcp__server__tool")).toBe("mcp_tool_call");
    expect(ompToolItemType("custom")).toBe("dynamic_tool_call");
  });
});

describe("mapOmpFrameToRuntimeEvents", () => {
  it("streams assistant text through item.started and content.delta", () => {
    const frame: OmpRpcFrame = {
      type: "message_update",
      message: { role: "assistant", content: "" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    };

    const result = mapOmpFrameToRuntimeEvents({ threadId, turnId }, frame);

    expect(result.events.map((event) => event.type)).toEqual(["item.started", "content.delta"]);
    expect(result.events[0]).toMatchObject({
      provider: "omp",
      type: "item.started",
      payload: { itemType: "assistant_message", status: "inProgress" },
      raw: { source: "omp.rpc.event", messageType: "message_update" },
    });
    expect(result.events[1]).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: "hello", contentIndex: 0 },
    });
    expect(result.activeAssistantItemId).toBeTruthy();
  });

  it("tracks tool lifecycle by tool call id", () => {
    const started = mapOmpFrameToRuntimeEvents(
      { threadId, turnId },
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "pwd" },
      },
    );
    const completed = mapOmpFrameToRuntimeEvents(
      { threadId, turnId, activeToolItems: started.activeToolItems },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: { stdout: "/repo" },
        isError: false,
      },
    );

    expect(started.events[0]).toMatchObject({
      type: "item.started",
      payload: { itemType: "command_execution", title: "pwd" },
      providerRefs: { providerItemId: "tool-1" },
    });
    expect(completed.events[0]).toMatchObject({
      type: "item.completed",
      payload: { itemType: "command_execution", status: "completed", detail: "/repo" },
      providerRefs: { providerItemId: "tool-1" },
    });
    expect(completed.activeToolItems.size).toBe(0);
  });

  it("dedupes identical tool partial snapshots and throttles changed ones", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-07T00:00:00Z"));
      const started = mapOmpFrameToRuntimeEvents(
        { threadId, turnId },
        { type: "tool_execution_start", toolCallId: "tool-2", toolName: "job", args: {} },
      );
      const update = (partialResult: unknown) =>
        mapOmpFrameToRuntimeEvents(
          { threadId, turnId, activeToolItems: started.activeToolItems },
          {
            type: "tool_execution_update",
            toolCallId: "tool-2",
            toolName: "job",
            args: {},
            partialResult,
          },
        );

      expect(update("## Still Running (1)").events.map((e) => e.type)).toEqual(["item.updated"]);
      // Identical snapshot 500ms later: dropped.
      vi.advanceTimersByTime(500);
      expect(update("## Still Running (1)").events).toEqual([]);
      // Changed snapshot still inside the throttle window: dropped.
      vi.advanceTimersByTime(500);
      expect(update("## Completed (1)").events).toEqual([]);
      // Same changed snapshot after the window: emitted (signature differs
      // from the last EMITTED snapshot, not the last seen one).
      vi.advanceTimersByTime(2_000);
      const emitted = update("## Completed (1)");
      expect(emitted.events.map((e) => e.type)).toEqual(["item.updated"]);
      expect(emitted.events[0]).toMatchObject({
        payload: { detail: "## Completed (1)" },
      });
      // Identical again, even long after the window: dropped.
      vi.advanceTimersByTime(10_000);
      expect(update("## Completed (1)").events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps agent_end to terminal turn completion and closes open message items", () => {
    const text = mapOmpFrameToRuntimeEvents(
      { threadId, turnId },
      {
        type: "message_update",
        message: { role: "assistant", content: "" },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" },
      },
    );
    const ended = mapOmpFrameToRuntimeEvents(
      { threadId, turnId, activeAssistantItemId: text.activeAssistantItemId },
      { type: "agent_end", messages: [] },
    );

    expect(ended.events.map((event) => event.type)).toEqual(["item.completed", "turn.completed"]);
    expect(ended.events[1]).toMatchObject({
      type: "turn.completed",
      payload: { state: "completed" },
    });
    expect(ended.turnCompleted).toBe(true);
  });

  it("maps subagent lifecycle and progress to task events", () => {
    const started = mapOmpFrameToRuntimeEvents(
      { threadId, turnId },
      {
        type: "subagent_lifecycle",
        payload: {
          id: "sub-1",
          agent: "explore",
          description: "Inspect code",
          status: "started",
          parentToolCallId: "tool-parent",
        },
      },
    );
    const progress = mapOmpFrameToRuntimeEvents(
      { threadId, turnId },
      {
        type: "subagent_progress",
        payload: {
          progress: {
            id: "sub-1",
            index: 0,
            agent: "explore",
            status: "running",
            task: "Inspect code",
            currentTool: "read",
            recentOutput: [],
            tokens: 123,
            cost: 0.01,
          },
        },
      },
    );

    expect(started.events[0]).toMatchObject({
      type: "task.started",
      payload: { taskId: "sub-1", description: "Inspect code", taskType: "subagent" },
      providerRefs: { providerItemId: "tool-parent" },
    });
    expect(progress.events[0]).toMatchObject({
      type: "task.progress",
      payload: {
        taskId: "sub-1",
        description: "Inspect code",
        summary: "read",
        lastToolName: "read",
        usage: { tokens: 123, cost: 0.01 },
      },
    });
  });

  it("degrades on structurally malformed frames instead of throwing", () => {
    const malformedMessage = mapOmpFrameToRuntimeEvents({ threadId, turnId }, {
      type: "message_update",
    } as unknown as OmpRpcFrame);
    expect(malformedMessage.events).toEqual([]);

    const malformedProgress = mapOmpFrameToRuntimeEvents({ threadId, turnId }, {
      type: "subagent_progress",
      payload: {},
    } as unknown as OmpRpcFrame);
    expect(malformedProgress.events).toEqual([]);

    const malformedLifecycle = mapOmpFrameToRuntimeEvents({ threadId, turnId }, {
      type: "subagent_lifecycle",
      payload: { status: "started" },
    } as unknown as OmpRpcFrame);
    expect(malformedLifecycle.events).toEqual([]);
  });

  it("throttles subagent progress frames per task id", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-07T00:00:00Z"));
      let marks: OmpFrameMappingResult["subagentProgressMarks"] | undefined;
      const progress = (tokens: number) => {
        const result = mapOmpFrameToRuntimeEvents(
          { threadId, turnId, subagentProgressMarks: marks },
          {
            type: "subagent_progress",
            payload: {
              progress: {
                id: "sub-1",
                index: 0,
                agent: "explore",
                status: "running",
                task: "Inspect code",
                currentTool: "read",
                recentOutput: [],
                tokens,
                cost: 0.01,
              },
            },
          },
        );
        marks = result.subagentProgressMarks;
        return result;
      };

      expect(progress(100).events.map((e) => e.type)).toEqual(["task.progress"]);
      // Changed tokens 150ms later: still inside the window, dropped.
      vi.advanceTimersByTime(150);
      expect(progress(120).events).toEqual([]);
      // Changed tokens after the window: emitted.
      vi.advanceTimersByTime(2_000);
      expect(progress(240).events.map((e) => e.type)).toEqual(["task.progress"]);
      // Identical frame after the window: dropped.
      vi.advanceTimersByTime(2_000);
      expect(progress(240).events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
