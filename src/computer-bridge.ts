import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { PublicError } from "./errors.js";
import type { ToolCallResult } from "./connectors.js";

export type Elicitation = { mode?: string; message: string; requestedSchema?: { type?: string; properties?: Record<string, unknown> }; _meta?: Record<string, unknown> };
export type ElicitationReply = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown>; _meta?: { persist: "always" | "session" } };
type Pending = { method: string; resolve: (result: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout>; timeout: number; cleanup: () => void };
type Message = { id?: number | string; method?: string; params?: Elicitation; result?: unknown; error?: unknown };

export class ComputerOutcomeUnknownError extends PublicError {}

/** Port of Pi's local MCP transport: pause deadlines during native approval. */
export class ComputerBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private ended = false;
  private eliciting = 0;
  private closing?: Promise<void>;
  private readonly exited: Promise<void>;

  private constructor(command: string, args: string[], env: NodeJS.ProcessEnv, private readonly onElicitation: (request: Elicitation) => Promise<ElicitationReply>) {
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => this.child.once("close", resolve));
    this.child.stderr.resume();
    this.child.stdin.on("error", () => {});
    this.child.on("error", () => this.fail("Computer Use runtime could not start."));
    this.child.on("exit", () => this.fail("Computer Use runtime disconnected. An in-flight UI action may have completed; inspect the app before retrying."));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: Message;
      try { message = JSON.parse(line) as Message; } catch { return; }
      if (message.method && message.id !== undefined) { void this.answer(message); return; }
      if (message.method || typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      pending.cleanup(); this.pending.delete(message.id);
      if (message.error) pending.reject(pending.method === "tools/call"
        ? new ComputerOutcomeUnknownError("Computer Use MCP request failed. An action may have completed; inspect the app before retrying.")
        : new PublicError("Computer Use MCP request failed; private diagnostics were withheld."));
      else pending.resolve(message.result);
    });
  }

  static async start(command: string, args: string[], env: NodeJS.ProcessEnv, onElicitation: (request: Elicitation) => Promise<ElicitationReply>, signal?: AbortSignal) {
    if (signal?.aborted) throw new PublicError("Computer Use cancelled before dispatch.");
    const bridge = new ComputerBridge(command, args, env, onElicitation);
    try {
      await bridge.request("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: { form: {} } }, clientInfo: { name: "codex-connectors-computer-use", version: "0.1.0" } }, 60_000, signal);
      bridge.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }

  request<T = ToolCallResult>(method: string, params: unknown, timeout = 60_000, signal?: AbortSignal): Promise<T> {
    if (this.ended) return Promise.reject(new PublicError("Computer Use bridge is closed. Restart the MCP server."));
    if (signal?.aborted) return Promise.reject(new PublicError("Computer Use cancelled before dispatch."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const abort = () => { this.fail("Computer Use cancelled after dispatch. An action may have completed; inspect the app before retrying."); void this.close(); };
      const pending: Pending = { method, resolve: (result) => resolve(result as T), reject, timeout,
        cleanup: () => { clearTimeout(pending.timer); signal?.removeEventListener("abort", abort); } };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, pending); this.arm(pending);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private arm(pending: Pending) {
    if (this.eliciting || this.ended) return;
    pending.timer = setTimeout(() => { this.fail("Computer Use timed out. An action may have completed; inspect the app before retrying."); void this.close(); }, pending.timeout);
  }

  private async answer(message: Message) {
    if (message.method !== "elicitation/create" || !message.params) {
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client request" } }); return;
    }
    this.eliciting++;
    for (const request of this.pending.values()) clearTimeout(request.timer);
    let result: ElicitationReply = { action: "cancel" };
    try { result = await this.onElicitation(message.params); } catch { /* Never silently approve. */ }
    this.send({ jsonrpc: "2.0", id: message.id, result });
    this.eliciting--;
    if (!this.eliciting) for (const request of this.pending.values()) this.arm(request);
  }

  private send(message: unknown) { if (!this.ended) this.child.stdin.write(JSON.stringify(message) + "\n"); }
  private fail(message: string) {
    this.ended = true;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(pending.method === "tools/call" ? new ComputerOutcomeUnknownError(message) : new PublicError(message));
    }
    this.pending.clear();
  }

  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }
  private async stop() {
    this.fail("Computer Use stopped. Check the app before retrying any interrupted UI action.");
    const term = setTimeout(() => this.child.kill("SIGTERM"), 300);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    this.child.stdin.end();
    await this.exited;
    clearTimeout(term); clearTimeout(kill);
  }
}
