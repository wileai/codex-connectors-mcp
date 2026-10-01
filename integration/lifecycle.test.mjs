import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexConnectors } from "../dist/connectors.js";
import { OutcomeUnknownError } from "../dist/app-server.js";

const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("App-server cleanup timed out"); await new Promise((r) => setTimeout(r, 50)); }
}

test("real app-server: missing binary, pre-dispatch cancellation, crash recovery, unknown read outcome", { timeout: 240_000 }, async (t) => {
  const missing = new CodexConnectors({ command: "/nonexistent/codex-connectors-mcp-codex" });
  await assert.rejects(missing.connectors(), /failed to start|ENOENT/);
  await missing.close();
  const service = new CodexConnectors();
  t.after(() => service.close());
  const tools = (await service.connectors()).flatMap((c) => c.tools);
  const profile = tools.find((tool) => tool.name === "github.get_profile");
  assert.ok(profile?.readOnly);
  await assert.rejects(service.call(profile.name, {}, AbortSignal.abort()), (error) => !(error instanceof OutcomeUnknownError) && /aborted/.test(error.message));
  const before = await service.pid();
  process.kill(before, "SIGKILL");
  await until(() => !running(before));
  assert.equal((await service.call(profile.name, {})).isError, false);
  assert.notEqual(await service.pid(), before);
  const pid = await service.pid();
  await service.close();
  await until(() => !running(pid));
  await assert.rejects(service.connectors(), /closed/);

  // Force a timeout after dispatching a harmless real read. No writes are issued.
  const slow = new CodexConnectors({ callTimeoutMs: 1 });
  t.after(() => slow.close());
  await slow.connectors();
  await assert.rejects(slow.call(profile.name, {}), (error) => error instanceof OutcomeUnknownError && /outcome unknown/.test(error.message));
  await slow.close();
});
