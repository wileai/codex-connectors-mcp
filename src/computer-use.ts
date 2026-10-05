import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ComputerBridge } from "./computer-bridge.js";
import { AppApprovals, type AppApprovalPrompt } from "./computer-permissions.js";
import { PublicError } from "./errors.js";

export type ComputerMode = "auto" | "disabled";
export function computerMode(value: string | undefined): ComputerMode {
  if (value === undefined || value === "auto" || value === "disabled") return value ?? "auto";
  throw new PublicError("CODEX_CONNECTORS_COMPUTER must be auto or disabled");
}

const instructions = "Use only @oai/sky for the user's requested UI task. Initialize: var sky = (await import('@oai/sky')).sky; " +
  "Use sky.list_apps(), sky.get_app_state({app,disableDiff:true}), sky.click({app,element_index}), sky.press_key({app,key}), sky.type_text({app,text}). " +
  "Print state.text with nodeRepl.write. AppState has .text and .screenshot.url; emit screenshots with nodeRepl.emitImage({bytes:await (await import('node:fs/promises')).readFile(new URL(state.screenshot.url)),mimeType:'image/jpeg'}). " +
  "Read fresh app state after every action before reusing element indices. Follow runtime instructions and native approvals. " +
  "If access is declined or approval unavailable, stop and report it; never change apps, reset, or use another automation route to evade approval. " +
  "App access does not authorize sending messages, submitting forms, deleting data, or changing settings; obtain the applicable user confirmation. Screenshots and app content enter this harness and its model.";

export const computerTools: Tool[] = [
  { name: "codex_computer_js", description: "Run persistent JavaScript in the macOS desktop Computer Use runtime. " + instructions,
    inputSchema: { type: "object", properties: { code: { type: "string" }, title: { type: "string" }, timeout_ms: { type: "integer", minimum: 1, maximum: 300000 } }, required: ["code"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "codex_computer_js_reset", description: "Reset JavaScript state. Does not approve app access or clear denied permissions or unknown outcomes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false } },
];
export const computerManagement: Tool[] = [
  { name: "codex_computer_status", description: "Show whether the desktop Computer Use runtime is available, and its version.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "codex_computer_forget", description: "Clear this bridge's saved and session app approvals and close its Computer Use runtime. Follows CODEX_CONNECTORS_WRITES. Does not clear an unknown outcome.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false } },
];

/** Automatic desktop discovery and runtime environment, adapted from Pi 0.3.1. */
export class CodexComputerUse {
  private bridge?: ComputerBridge;
  private readonly abort = new AbortController();
  private readonly approvals: AppApprovals;
  private readonly runtimeEnv: NodeJS.ProcessEnv;
  private readonly node: string;
  private readonly wrapper: string;
  private readonly modules: string;
  readonly unavailable?: string;

  constructor(mode: ComputerMode, private readonly prompt?: AppApprovalPrompt, env: NodeJS.ProcessEnv = process.env) {
    const app = env.CODEX_CONNECTORS_COMPUTER_APP ?? "/Applications/ChatGPT.app";
    const root = join(app, "Contents/Resources/cua_node");
    this.modules = join(root, "lib/node_modules");
    this.node = join(root, "bin/node");
    const repl = join(root, "bin/node_repl");
    this.wrapper = join(this.modules, "@oai/cua-repl/bin/cua-repl.mjs");
    this.unavailable = mode === "disabled" ? "Computer Use is disabled by CODEX_CONNECTORS_COMPUTER."
      : process.platform !== "darwin" ? "Computer Use requires macOS."
      : [this.node, repl, this.wrapper, join(this.modules, "@oai/sky/package.json")].some((path) => !existsSync(path))
        ? "Desktop Computer Use runtime missing. Install ChatGPT with Computer Use, or set CODEX_CONNECTORS_COMPUTER_APP to its installed path." : undefined;
    const base = (env.CODEX_HOME ?? join(homedir(), ".codex")).replace(/^~(?=\/|$)/, homedir());
    this.approvals = new AppApprovals(join(base, "codex-connectors-mcp", "computer-use-approvals.json"));
    this.runtimeEnv = {
      ...env,
      SKY_CUA_SERVICE_PATH: env.SKY_CUA_SERVICE_PATH ?? join(homedir(), ".codex/computer-use/Codex Computer Use.app"),
      CUA_REPL_NODE_REPL_PATH: repl, CUA_REPL_ENABLED_SURFACES: "computer",
      NODE_REPL_UNTRUSTED_ENV_ALLOWLIST: "CUA_REPL_ENABLED_SURFACES",
      NODE_REPL_JS_BANNER: 'globalThis.sky = (await import("@oai/sky")).sky;',
      NODE_REPL_NODE_PATH: this.node, NODE_REPL_NODE_MODULE_DIRS: this.modules,
      NODE_REPL_TRUSTED_CODE_PATHS: this.modules,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: "@oai/sky/service" }),
    };
  }

  status() {
    if (this.unavailable) return { available: false, reason: this.unavailable };
    try {
      const pkg = JSON.parse(readFileSync(join(this.modules, "@oai/sky/package.json"), "utf8")) as { version: string };
      return { available: true, version: pkg.version };
    } catch { throw new PublicError("Computer Use runtime metadata could not be read."); }
  }
  async call(name: "js" | "js_reset", args: Record<string, unknown>, callerSignal?: AbortSignal): Promise<CallToolResult> {
    if (this.unavailable) throw new PublicError(this.unavailable);
    const signal = AbortSignal.any([this.abort.signal, ...(callerSignal ? [callerSignal] : [])]);
    if (signal.aborted) throw new PublicError("Computer Use cancelled before dispatch.");
    // Native approval belongs to the current operation, including startup.
    this.activeSignal = signal;
    try {
      this.bridge ??= await ComputerBridge.start(this.node, [this.wrapper], this.runtimeEnv,
        (request) => this.activeSignal ? this.approvals.confirm(this.prompt, request, this.activeSignal) : Promise.resolve({ action: "decline" }), signal);
      return await this.bridge.request<CallToolResult>("tools/call", { name, arguments: args }, Math.max(60_000, Number(args.timeout_ms ?? 30000) + 10000), signal);
    } finally { this.activeSignal = undefined; }
  }
  private activeSignal?: AbortSignal;
  async forget() {
    await this.bridge?.close(); this.bridge = undefined;
    this.approvals.forget();
  }
  async close() {
    this.abort.abort(); this.approvals.clearSession();
    await this.bridge?.close();
  }
}
