import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OmpRpcClient, type OmpRpcExitInfo, type OmpRpcProtocolWarning } from "./ompRpcClient.ts";
import type { OmpRpcFrame } from "./ompRpcTypes.ts";

/**
 * These tests spawn a real Node "fake omp" child process rather than mocking
 * `node:child_process`. `OmpRpcClient.start()` runs
 * `spawn(binaryPath, ["--mode", "rpc", ...args])`, and Node itself rejects an
 * unrecognized `--mode` flag when `binaryPath` is `node` directly (e.g.
 * `node --mode rpc -e "..."` fails with "bad option: --mode"). So each fake
 * binary below is written to a temp file with a `#!/usr/bin/env node`
 * shebang and executed directly; the shebang script itself ignores argv
 * (`--mode rpc`) entirely and just talks NDJSON over stdio.
 */

const STDIN_END_EXIT = `process.stdin.on("end", () => process.exit(0));
process.stdin.resume();`;

const READY_ONLY_SCRIPT = `
console.log(JSON.stringify({ type: "ready" }));
${STDIN_END_EXIT}
`;

const NEVER_READY_SCRIPT = `
${STDIN_END_EXIT}
`;

const REVERSE_ORDER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
console.log(JSON.stringify({ type: "ready" }));
const received = [];
function respond(req) {
  if (req.type === "get_state") {
    console.log(JSON.stringify({
      type: "response",
      id: req.id,
      command: "get_state",
      success: true,
      data: { sessionId: "sess-state", messageCount: 1 },
    }));
  } else if (req.type === "get_available_commands") {
    console.log(JSON.stringify({
      type: "response",
      id: req.id,
      command: "get_available_commands",
      success: true,
      data: { commands: [] },
    }));
  }
}
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch (error) {
    return;
  }
  received.push(req);
  if (received.length === 2) {
    respond(received[1]);
    respond(received[0]);
  }
});
${STDIN_END_EXIT}
`;

const FAILURE_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
console.log(JSON.stringify({ type: "ready" }));
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch (error) {
    return;
  }
  console.log(JSON.stringify({
    type: "response",
    id: req.id,
    command: req.type,
    success: false,
    error: "Model not found",
  }));
});
${STDIN_END_EXIT}
`;

const MALFORMED_THEN_VALID_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
console.log(JSON.stringify({ type: "ready" }));
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch (error) {
    return;
  }
  console.log("not-json-garbage-line");
  console.log(JSON.stringify({
    type: "response",
    id: req.id,
    command: req.type,
    success: true,
    data: {},
  }));
});
${STDIN_END_EXIT}
`;

const UNSOLICITED_RESPONSES_SCRIPT = `
console.log(JSON.stringify({ type: "ready" }));
console.log(JSON.stringify({ type: "response", command: "get_state", success: true, data: {} }));
console.log(JSON.stringify({ type: "response", id: "unknown-id", command: "get_state", success: true, data: {} }));
${STDIN_END_EXIT}
`;

const EXIT_ON_REQUEST_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
console.log(JSON.stringify({ type: "ready" }));
rl.on("line", () => {
  process.exit(7);
});
${STDIN_END_EXIT}
`;

const NON_RESPONSE_FRAME_SCRIPT = `
console.log(JSON.stringify({ type: "ready" }));
console.log(JSON.stringify({ type: "agent_start" }));
${STDIN_END_EXIT}
`;

function writeFakeOmp(dir: string, body: string): string {
  const filePath = path.join(dir, "fake-omp");
  fs.writeFileSync(filePath, `#!/usr/bin/env bun\n${body}\n`);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-client-test-"));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("OmpRpcClient", () => {
  it("resolves start() once the ready frame arrives", async () => {
    await withTempDir(async (dir) => {
      const binaryPath = writeFakeOmp(dir, READY_ONLY_SCRIPT);
      const client = new OmpRpcClient({ binaryPath, cwd: dir, readyTimeoutMs: 2000 });
      try {
        await expect(client.start()).resolves.toBeUndefined();
      } finally {
        await client.stop();
      }
    });
  });

  it("rejects start() when no ready frame arrives before the timeout", async () => {
    await withTempDir(async (dir) => {
      const binaryPath = writeFakeOmp(dir, NEVER_READY_SCRIPT);
      const client = new OmpRpcClient({ binaryPath, cwd: dir, readyTimeoutMs: 150 });
      try {
        await expect(client.start()).rejects.toThrow(/Timed out waiting for omp RPC ready frame/);
      } finally {
        await client.stop();
      }
    });
  });

  it("resolves requests by id even when responses arrive out of order", async () => {
    await withTempDir(async (dir) => {
      const binaryPath = writeFakeOmp(dir, REVERSE_ORDER_SCRIPT);
      const client = new OmpRpcClient({
        binaryPath,
        cwd: dir,
        readyTimeoutMs: 2000,
        requestTimeoutMs: 2000,
      });
      try {
        await client.start();
        const statePromise = client.request({ type: "get_state" });
        const commandsPromise = client.request({ type: "get_available_commands" });
        const [state, commands] = await Promise.all([statePromise, commandsPromise]);
        expect(state).toMatchObject({
          command: "get_state",
          success: true,
          data: { sessionId: "sess-state" },
        });
        expect(commands).toMatchObject({
          command: "get_available_commands",
          success: true,
          data: { commands: [] },
        });
      } finally {
        await client.stop();
      }
    });
  });

  it("rejects the request promise with the server-provided error message", async () => {
    await withTempDir(async (dir) => {
      const binaryPath = writeFakeOmp(dir, FAILURE_SCRIPT);
      const client = new OmpRpcClient({
        binaryPath,
        cwd: dir,
        readyTimeoutMs: 2000,
        requestTimeoutMs: 2000,
      });
      try {
        await client.start();
        await expect(
          client.request({ type: "set_model", provider: "test", modelId: "m1" }),
        ).rejects.toThrow("Model not found");
      } finally {
        await client.stop();
      }
    });
  });

  it("survives a malformed line and still resolves the pending request", async () => {
    await withTempDir(async (dir) => {
      const binaryPath = writeFakeOmp(dir, MALFORMED_THEN_VALID_SCRIPT);
      const warnings: OmpRpcProtocolWarning[] = [];
      const client = new OmpRpcClient({
        binaryPath,
        cwd: dir,
        readyTimeoutMs: 2000,
        requestTimeoutMs: 2000,
        onProtocolWarning: (warning) => warnings.push(warning),
      });
      try {
        await client.start();
        const response = await client.request({ type: "get_state" });
        expect(response).toMatchObject({ command: "get_state", success: true });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.message).toBe("Failed to parse omp RPC frame.");
      } finally {
        await client.stop();
      }
    });
  });

  it("warns but does not crash on responses with missing or unknown ids", async () => {
    await withTempDir(async (dir) => {
      const binaryPath = writeFakeOmp(dir, UNSOLICITED_RESPONSES_SCRIPT);
      const warnings: OmpRpcProtocolWarning[] = [];
      const client = new OmpRpcClient({
        binaryPath,
        cwd: dir,
        readyTimeoutMs: 2000,
        onProtocolWarning: (warning) => warnings.push(warning),
      });
      try {
        await client.start();
        await delay(100);
        const messages = warnings.map((warning) => warning.message);
        expect(messages).toContain("Received omp RPC response without id.");
        expect(messages).toContain("Received omp RPC response for unknown id.");
      } finally {
        await client.stop();
      }
    });
  });

  it("rejects pending requests immediately when stop() is called", async () => {
    await withTempDir(async (dir) => {
      const binaryPath = writeFakeOmp(dir, READY_ONLY_SCRIPT);
      const exits: OmpRpcExitInfo[] = [];
      const client = new OmpRpcClient({
        binaryPath,
        cwd: dir,
        readyTimeoutMs: 2000,
        requestTimeoutMs: 5000,
        onExit: (exit) => exits.push(exit),
      });
      await client.start();
      const pending = client.request({ type: "get_state" });
      const stopPromise = client.stop();
      await expect(pending).rejects.toThrow("omp RPC client stopped.");
      await stopPromise;
      expect(exits).toHaveLength(1);
      expect(exits[0]?.requested).toBe(true);
    });
  });

  it("rejects pending requests and reports onExit when the process exits unexpectedly", async () => {
    await withTempDir(async (dir) => {
      const binaryPath = writeFakeOmp(dir, EXIT_ON_REQUEST_SCRIPT);
      const exits: OmpRpcExitInfo[] = [];
      const client = new OmpRpcClient({
        binaryPath,
        cwd: dir,
        readyTimeoutMs: 2000,
        requestTimeoutMs: 2000,
        onExit: (exit) => exits.push(exit),
      });
      try {
        await client.start();
        await expect(client.request({ type: "get_state" })).rejects.toThrow(/exited unexpectedly/);
        expect(exits).toHaveLength(1);
        expect(exits[0]?.requested).toBe(false);
        expect(exits[0]?.code).toBe(7);
      } finally {
        await client.stop();
      }
    });
  });

  it("delivers non-response frames to onFrame", async () => {
    await withTempDir(async (dir) => {
      const binaryPath = writeFakeOmp(dir, NON_RESPONSE_FRAME_SCRIPT);
      const frames: OmpRpcFrame[] = [];
      const client = new OmpRpcClient({
        binaryPath,
        cwd: dir,
        readyTimeoutMs: 2000,
        onFrame: (frame) => frames.push(frame),
      });
      try {
        await client.start();
        await delay(100);
        expect(frames.some((frame) => frame.type === "agent_start")).toBe(true);
      } finally {
        await client.stop();
      }
    });
  });
});
