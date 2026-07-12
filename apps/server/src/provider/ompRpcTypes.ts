/**
 * Vendored structural RPC wire types for Oh My Pi RPC mode.
 *
 * Source: /home/fedora/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts
 * Version: 16.3.9
 *
 * These are intentionally self-contained and only model the fields Synara's
 * adapter consumes. Unknown upstream fields remain accepted structurally.
 */

export const VENDORED_OMP_VERSION = "16.3.9";

export type ThinkingLevel = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType?: string;
}

export interface ToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ThinkingContent {
  readonly type: "thinking";
  readonly thinking?: string;
  readonly text?: string;
}

export type AgentMessageContent =
  | string
  | ReadonlyArray<TextContent | ImageContent | ToolCall | ThinkingContent>;

export interface AgentMessage {
  readonly role: string;
  readonly content: AgentMessageContent;
  readonly [key: string]: unknown;
}

export interface TodoPhase {
  readonly id: string;
  readonly name: string;
  readonly tasks: ReadonlyArray<{
    readonly id: string;
    readonly content: string;
    readonly status: "pending" | "in_progress" | "completed" | string;
  }>;
}

export interface Model {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly providerName?: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly thinkingLevelMap?: Partial<Record<Exclude<ThinkingLevel, "inherit">, string | null>>;
  readonly [key: string]: unknown;
}

export interface ContextUsage {
  readonly tokens?: number;
  readonly contextWindow?: number;
  readonly percent?: number;
}

export interface SessionStats {
  readonly tokens?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
  readonly contextUsage?: ContextUsage;
  readonly [key: string]: unknown;
}

export interface RpcSessionState {
  readonly model?: Model;
  readonly thinkingLevel: ThinkingLevel | undefined;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly steeringMode: "all" | "one-at-a-time";
  readonly followUpMode: "all" | "one-at-a-time";
  readonly interruptMode: "immediate" | "wait";
  readonly sessionFile?: string;
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly autoCompactionEnabled: boolean;
  readonly messageCount: number;
  readonly queuedMessageCount: number;
  readonly todoPhases: TodoPhase[];
  readonly systemPrompt?: string[];
  readonly dumpTools?: Array<{
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
    readonly examples?: readonly unknown[];
  }>;
  readonly contextUsage?: ContextUsage;
}

export interface RpcAvailableSlashCommand {
  readonly name: string;
  readonly aliases?: string[];
  readonly description?: string;
  readonly input?: { readonly hint?: string };
  readonly subcommands?: Array<{
    readonly name: string;
    readonly description?: string;
    readonly usage?: string;
  }>;
  readonly source: string;
}

export interface RpcSubagentSnapshot {
  readonly id: string;
  readonly index: number;
  readonly agent: string;
  readonly agentSource: string;
  readonly description?: string;
  readonly status: string;
  readonly task?: string;
  readonly assignment?: string;
  readonly sessionFile?: string;
  readonly lastUpdate: number;
  readonly progress?: AgentProgress;
  readonly parentToolCallId?: string;
}

export type RpcCommand =
  | {
      id?: string;
      type: "prompt";
      message: string;
      images?: ImageContent[];
      streamingBehavior?: "steer" | "followUp";
    }
  | { id?: string; type: "steer"; message: string; images?: ImageContent[] }
  | { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_available_commands" }
  | { id?: string; type: "set_todos"; phases: TodoPhase[] }
  | { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
  | { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
  | { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
  | { id?: string; type: "get_subagents" }
  | {
      id?: string;
      type: "get_subagent_messages";
      subagentId?: string;
      sessionFile?: string;
      fromByte?: number;
    }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  | { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "set_auto_compaction"; enabled: boolean }
  | { id?: string; type: "set_auto_retry"; enabled: boolean }
  | { id?: string; type: "abort_retry" }
  | { id?: string; type: "bash"; command: string }
  | { id?: string; type: "abort_bash" }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "export_html"; outputPath?: string }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "branch"; entryId: string }
  | { id?: string; type: "get_branch_messages" }
  | { id?: string; type: "get_last_assistant_text" }
  | { id?: string; type: "set_session_name"; name: string }
  | { id?: string; type: "handoff"; customInstructions?: string }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_login_providers" }
  | { id?: string; type: "login"; providerId: string };

export type RpcCommandType = RpcCommand["type"];

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export type RpcResponse =
  | {
      id?: string;
      type: "response";
      command: "prompt";
      success: true;
      data?: { agentInvoked: boolean };
    }
  | { id?: string; type: "response"; command: "steer"; success: true }
  | { id?: string; type: "response"; command: "follow_up"; success: true }
  | { id?: string; type: "response"; command: "abort"; success: true }
  | { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
  | {
      id?: string;
      type: "response";
      command: "new_session";
      success: true;
      data: { cancelled: boolean };
    }
  | { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
  | {
      id?: string;
      type: "response";
      command: "get_available_commands";
      success: true;
      data: { commands: RpcAvailableSlashCommand[] };
    }
  | {
      id?: string;
      type: "response";
      command: "set_todos";
      success: true;
      data: { todoPhases: TodoPhase[] };
    }
  | {
      id?: string;
      type: "response";
      command: "set_host_tools";
      success: true;
      data: { toolNames: string[] };
    }
  | {
      id?: string;
      type: "response";
      command: "set_host_uri_schemes";
      success: true;
      data: { schemes: string[] };
    }
  | {
      id?: string;
      type: "response";
      command: "set_subagent_subscription";
      success: true;
      data: { level: RpcSubagentSubscriptionLevel };
    }
  | {
      id?: string;
      type: "response";
      command: "get_subagents";
      success: true;
      data: { subagents: RpcSubagentSnapshot[] };
    }
  | { id?: string; type: "response"; command: "set_model"; success: true; data: Model }
  | {
      id?: string;
      type: "response";
      command: "cycle_model";
      success: true;
      data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
    }
  | {
      id?: string;
      type: "response";
      command: "get_available_models";
      success: true;
      data: { models: Model[] };
    }
  | { id?: string; type: "response"; command: "set_thinking_level"; success: true }
  | {
      id?: string;
      type: "response";
      command: "cycle_thinking_level";
      success: true;
      data: { level: string } | null;
    }
  | { id?: string; type: "response"; command: "compact"; success: true; data: unknown }
  | {
      id?: string;
      type: "response";
      command: "get_session_stats";
      success: true;
      data: SessionStats;
    }
  | {
      id?: string;
      type: "response";
      command: "switch_session";
      success: true;
      data: { cancelled: boolean };
    }
  | {
      id?: string;
      type: "response";
      command: "branch";
      success: true;
      data: { text: string; cancelled: boolean };
    }
  | {
      id?: string;
      type: "response";
      command: "get_branch_messages";
      success: true;
      data: { messages: Array<{ entryId: string; text: string }> };
    }
  | {
      id?: string;
      type: "response";
      command: "get_messages";
      success: true;
      data: { messages: AgentMessage[] };
    }
  | { id?: string; type: "response"; command: string; success: true; data?: unknown }
  | { id?: string; type: "response"; command: string; success: false; error: string };

export type AssistantMessageEvent =
  | { type: "text_start"; contentIndex: number; partial?: AgentMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial?: AgentMessage }
  | { type: "text_end"; contentIndex: number; partial?: AgentMessage }
  | { type: "thinking_start"; contentIndex: number; partial?: AgentMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial?: AgentMessage }
  | { type: "thinking_end"; contentIndex: number; partial?: AgentMessage }
  | {
      type: "toolcall_start";
      contentIndex: number;
      id?: string;
      toolName?: string;
      partial?: AgentMessage;
    }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial?: AgentMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall?: ToolCall; partial?: AgentMessage }
  | { type: "done"; partial?: AgentMessage }
  | { type: "error"; error?: unknown; partial?: AgentMessage };

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; telemetry?: unknown; coverage?: unknown }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: unknown[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
      intent?: string;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    };

export type AgentSessionEvent =
  | AgentEvent
  | { type: "auto_compaction_start"; reason?: string; action?: string }
  | {
      type: "auto_compaction_end";
      action?: string;
      result?: unknown;
      aborted?: boolean;
      willRetry?: boolean;
      errorMessage?: string;
      skipped?: boolean;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs?: number;
      errorMessage: string;
      errorId?: number;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt?: number;
      finalError?: string;
      recoveredErrors?: unknown[];
    }
  | { type: "notice"; level?: "info" | "warning" | "error"; message: string; source?: string }
  | {
      type: "thinking_level_changed";
      thinkingLevel?: ThinkingLevel;
      configured?: string;
      resolved?: string;
    }
  | { type: "todo_reminder"; [key: string]: unknown }
  | { type: "todo_auto_clear"; [key: string]: unknown }
  | { type: "ttsr_triggered"; [key: string]: unknown }
  | { type: "irc_message"; [key: string]: unknown }
  | { type: "goal_updated"; [key: string]: unknown }
  | { type: "retry_fallback_applied"; [key: string]: unknown }
  | { type: "retry_fallback_succeeded"; [key: string]: unknown };

export interface AgentProgress {
  readonly index: number;
  readonly id: string;
  readonly agent: string;
  readonly agentSource?: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "aborted";
  readonly task: string;
  readonly assignment?: string;
  readonly description?: string;
  readonly currentTool?: string;
  readonly recentOutput?: string[];
  readonly tokens?: number;
  readonly cost?: number;
  readonly [key: string]: unknown;
}

export interface SubagentLifecyclePayload {
  readonly id: string;
  readonly agent: string;
  readonly agentSource?: string;
  readonly description?: string;
  readonly status: "started" | "completed" | "failed" | "aborted";
  readonly sessionFile?: string;
  readonly parentToolCallId?: string;
  readonly index?: number;
  readonly detached?: boolean;
}

export interface SubagentProgressPayload {
  readonly index?: number;
  readonly agent?: string;
  readonly task?: string;
  readonly parentToolCallId?: string;
  readonly assignment?: string;
  readonly progress: AgentProgress;
  readonly sessionFile?: string;
  readonly detached?: boolean;
}

export interface SubagentEventPayload {
  readonly id: string;
  readonly event: AgentSessionEvent;
}

export type RpcSubagentFrame =
  | { type: "subagent_lifecycle"; payload: SubagentLifecyclePayload }
  | { type: "subagent_progress"; payload: SubagentProgressPayload }
  | { type: "subagent_event"; payload: SubagentEventPayload };

export type RpcExtensionUIRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      promptStyle?: boolean;
    }
  | { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText: string | undefined;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines: string[] | undefined;
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "open_url";
      url: string;
      launchUrl?: string;
      instructions?: string;
    };

export type RpcExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

export interface RpcHostToolDefinition {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly hidden?: boolean;
}

export interface RpcHostUriSchemeDefinition {
  readonly scheme: string;
  readonly description?: string;
  readonly writable?: boolean;
  readonly immutable?: boolean;
}

export type RpcOtherFrame =
  | { type: "ready" }
  | { type: "available_commands_update"; commands: RpcAvailableSlashCommand[] }
  | { type: "prompt_result"; id?: string; agentInvoked: boolean }
  | { type: "command_output"; output?: string; [key: string]: unknown }
  | { type: "session_info_update"; title?: string; sessionId?: string; [key: string]: unknown }
  | { type: "config_update"; model?: Model; thinkingLevel?: ThinkingLevel; [key: string]: unknown }
  | { type: "extension_error"; extensionPath?: string; event?: string; error?: unknown }
  | {
      type: "host_tool_call";
      id: string;
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | { type: "host_tool_cancel"; id: string; targetId: string }
  | {
      type: "host_uri_request";
      id: string;
      operation: "read" | "write";
      url: string;
      content?: string;
    }
  | { type: "host_uri_cancel"; id: string; targetId: string };

export type OmpRpcFrame =
  | RpcResponse
  | AgentSessionEvent
  | RpcSubagentFrame
  | RpcExtensionUIRequest
  | RpcOtherFrame;
