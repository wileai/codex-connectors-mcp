import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { PublicError } from "./errors.js";
import type { Elicitation, ElicitationReply } from "./computer-bridge.js";

export type ApprovalChoice = "once" | "session" | "always" | "deny";
export type AppApprovalPrompt = (request: Elicitation, choices: ApprovalChoice[], signal: AbortSignal) => Promise<ApprovalChoice | undefined>;

/** Native runtime policy determines whether a grant can be remembered. */
export class AppApprovals {
  private readonly session = new Set<string>();
  constructor(private readonly file: string) {}
  clearSession() { this.session.clear(); }
  forget() { this.clearSession(); rmSync(this.file, { force: true }); }
  private saved(): string[] {
    try { const data: unknown = JSON.parse(readFileSync(this.file, "utf8")); return Array.isArray(data) ? data.filter((v): v is string => typeof v === "string") : []; }
    catch { return []; }
  }
  async confirm(prompt: AppApprovalPrompt | undefined, request: Elicitation, signal: AbortSignal): Promise<ElicitationReply> {
    if (signal.aborted || (request.mode && request.mode !== "form") || Object.keys(request.requestedSchema?.properties ?? {}).length) return { action: "decline" };
    const meta = request._meta ?? {};
    const app = (meta.tool_params as { app?: unknown } | undefined)?.app;
    const persist = Array.isArray(meta.persist) ? meta.persist : [];
    const key = meta.connector_id === "computer-use" && typeof app === "string" && app ? app : undefined;
    const canSession = !!key && persist.includes("session");
    const canAlways = canSession && persist.includes("always");
    if ((canSession && this.session.has(key!)) || (canAlways && this.saved().includes(key!))) {
      return { action: "accept", content: { source: "computer-use-persisted-state" } };
    }
    if (!prompt) return { action: "decline" };
    const choices: ApprovalChoice[] = ["once", ...(canSession ? ["session" as const] : []), ...(canAlways ? ["always" as const] : []), "deny"];
    const choice = await prompt(request, choices, signal);
    if (signal.aborted) return { action: "cancel" };
    if (!choice || !choices.includes(choice) || choice === "deny") return { action: "decline" };
    if (choice === "session") this.session.add(key!);
    if (choice === "always") {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify([...new Set([...this.saved(), key!])]), { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.file);
      } catch { throw new PublicError("Could not save Computer Use app approval."); }
      finally { rmSync(temporary, { force: true }); }
    }
    return { action: "accept", content: {}, ...(choice === "always" ? { _meta: { persist: "always" as const } } : {}) };
  }
}
