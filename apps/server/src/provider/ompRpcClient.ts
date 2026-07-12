import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";

import type {
  OmpRpcFrame,
  RpcCommand,
  RpcCommandType,
  RpcExtensionUIResponse,
  RpcResponse,
} from "./ompRpcTypes.ts";

export interface OmpRpcProtocolWarning {
  readonly message: string;
  readonly detail?: unknown;
}

export interface OmpRpcExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly requested: boolean;
}

export interface OmpRpcClientOptions {
  readonly binaryPath: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly longRequestTimeoutMs?: number;
  readonly onFrame?: (frame: OmpRpcFrame) => void;
  readonly onProtocolWarning?: (warning: OmpRpcProtocolWarning) => void;
  readonly onExit?: (exit: OmpRpcExitInfo) => void;
}

interface PendingRequest {
  readonly command: RpcCommandType;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (response: RpcResponse) => void;
  readonly reject: (error: Error) => void;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_LONG_REQUEST_TIMEOUT_MS = 10 * 60_000;
const STOP_KILL_TIMEOUT_MS = 1_500;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isResponseFrame(frame: OmpRpcFrame): frame is RpcResponse {
  return frame.type === "response";
}

function isLongCommand(command: RpcCommandType): boolean {
  return command === "bash" || command === "compact";
}

export class OmpRpcClient {
  readonly #options: Required<
    Pick<OmpRpcClientOptions, "readyTimeoutMs" | "requestTimeoutMs" | "longRequestTimeoutMs">
  > &
    OmpRpcClientOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #readline: readline.Interface | undefined;
  #pending = new Map<string, PendingRequest>();
  #nextRequestId = 1;
  #ready = false;
  #stopping = false;
  #exited = false;
  #readyWaiter:
    | {
        readonly timeout: ReturnType<typeof setTimeout>;
        readonly resolve: () => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;

  constructor(options: OmpRpcClientOptions) {
    this.#options = {
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      longRequestTimeoutMs: options.longRequestTimeoutMs ?? DEFAULT_LONG_REQUEST_TIMEOUT_MS,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.#child) return;
    const child = spawn(
      this.#options.binaryPath,
      ["--mode", "rpc", ...(this.#options.args ?? [])],
      {
        cwd: this.#options.cwd,
        env: { ...process.env, ...this.#options.env },
        stdio: "pipe",
      },
    );
    this.#child = child;
    child.on("error", (error) => {
      this.#warn("omp RPC process error", error);
      this.#rejectReady(error);
      this.#rejectAll(error);
    });
    child.on("exit", (code, signal) => {
      this.#exited = true;
      this.#readline?.close();
      this.#rejectReady(
        new Error(`omp RPC process exited before ready (${code ?? signal ?? "unknown"}).`),
      );
      if (!this.#stopping) {
        this.#rejectAll(
          new Error(`omp RPC process exited unexpectedly (${code ?? signal ?? "unknown"}).`),
        );
      }
      this.#options.onExit?.({ code, signal, requested: this.#stopping });
    });
    // Without a listener, a write racing process death (EPIPE) is an unhandled
    // stream error that crashes the whole server, not just this session.
    child.stdin.on("error", (error) => {
      this.#warn("omp RPC stdin error", error);
    });
    child.stderr.on("data", (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.trim().length > 0) {
        this.#warn("omp RPC stderr", text);
      }
    });
    const rl = readline.createInterface({ input: child.stdout });
    this.#readline = rl;
    rl.on("line", (line) => this.#handleLine(line));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#readyWaiter = undefined;
        // Reap the never-ready child so failed session starts cannot
        // accumulate orphan omp processes.
        this.#stopping = true;
        child.kill("SIGKILL");
        reject(new Error("Timed out waiting for omp RPC ready frame."));
      }, this.#options.readyTimeoutMs);
      this.#readyWaiter = { timeout, resolve, reject };
      if (this.#ready) {
        clearTimeout(timeout);
        this.#readyWaiter = undefined;
        resolve();
      }
    });
  }

  async request<TResponse extends RpcResponse = RpcResponse>(
    command: RpcCommand,
  ): Promise<TResponse> {
    if (!this.#child || this.#exited) {
      throw new Error("omp RPC process is not running.");
    }
    const id = `req_${this.#nextRequestId++}`;
    const request = { ...command, id } as RpcCommand;
    const timeoutMs = isLongCommand(command.type)
      ? this.#options.longRequestTimeoutMs
      : this.#options.requestTimeoutMs;
    const responsePromise = new Promise<RpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for omp RPC response to ${command.type}.`));
      }, timeoutMs);
      this.#pending.set(id, { command: command.type, timeout, resolve, reject });
    });
    this.send(request);
    return (await responsePromise) as TResponse;
  }

  send(frame: RpcCommand | RpcExtensionUIResponse): void {
    if (!this.#child || this.#exited || !this.#child.stdin.writable) {
      throw new Error("omp RPC process is not running.");
    }
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#rejectAll(new Error("omp RPC client stopped."));
    if (!this.#child || this.#exited) return;
    const child = this.#child;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(killTimeout);
        resolve();
      };
      const killTimeout = setTimeout(() => {
        if (!this.#exited) child.kill("SIGKILL");
        resolve();
      }, STOP_KILL_TIMEOUT_MS);
      child.once("exit", done);
      child.stdin.end();
    });
  }

  #handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      this.#warn("Failed to parse omp RPC frame.", { line, cause });
      return;
    }
    if (!isObject(parsed) || typeof parsed.type !== "string") {
      this.#warn("Ignored malformed omp RPC frame.", parsed);
      return;
    }
    const frame = parsed as OmpRpcFrame;
    if (frame.type === "ready") {
      this.#ready = true;
      if (this.#readyWaiter) {
        clearTimeout(this.#readyWaiter.timeout);
        this.#readyWaiter.resolve();
        this.#readyWaiter = undefined;
      }
      this.#options.onFrame?.(frame);
      return;
    }
    if (isResponseFrame(frame)) {
      if (!frame.id) {
        this.#warn("Received omp RPC response without id.", frame);
        return;
      }
      const pending = this.#pending.get(frame.id);
      if (!pending) {
        this.#warn("Received omp RPC response for unknown id.", frame);
        return;
      }
      this.#pending.delete(frame.id);
      clearTimeout(pending.timeout);
      if (frame.success === false) {
        pending.reject(new Error(frame.error || `omp RPC command ${pending.command} failed.`));
        return;
      }
      pending.resolve(frame);
      return;
    }
    // The cast above trusts vendored wire types; a drifted upstream payload can
    // make the consumer throw. Contain it to a protocol warning instead of an
    // exception escaping the readline callback.
    try {
      this.#options.onFrame?.(frame);
    } catch (cause) {
      this.#warn("omp RPC frame handler failed.", { frame: frame.type, cause });
    }
  }

  #rejectReady(error: Error): void {
    if (!this.#readyWaiter) return;
    clearTimeout(this.#readyWaiter.timeout);
    this.#readyWaiter.reject(error);
    this.#readyWaiter = undefined;
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  #warn(message: string, detail?: unknown): void {
    this.#options.onProtocolWarning?.({ message, ...(detail !== undefined ? { detail } : {}) });
  }
}
