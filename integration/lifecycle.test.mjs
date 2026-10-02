import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CodexConnectors } from "../dist/connectors.js";
import { AppServerClient, OutcomeUnknownError } from "../dist/app-server.js";

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


test("real Codex diagnostic text stays private for startup and RPC failures", { timeout: 90_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "codex-diagnostic-scenario-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const marker = "private-config-audit-sentinel";
  writeFileSync(join(home, "config.toml"), `approval_policy = "${marker}"\n`);
  const command = process.env.CODEX_CONNECTORS_CODEX ?? "codex";
  const env = { ...process.env, CODEX_HOME: home };
  // Establish that the real CLI actually emits the synthetic sensitive value.
  const raw = spawnSync(command, ["app-server", "--listen", "stdio://"], { env, encoding: "utf8", timeout: 15_000 });
  assert.ok(raw.stderr?.includes(marker), "Real Codex diagnostic must contain the scenario marker");
  // Codex logs invalid configuration but initializes with defaults.
  const client = await AppServerClient.start({ command, env });
  t.after(() => client.close());
  await assert.rejects(client.request(marker, {}), (error) =>
    /rejected the request/.test(error.message) && !error.message.includes(marker));
  // A pending discovery failure must not attach the earlier stderr diagnostic.
  process.kill(client.pid, "SIGSTOP");
  const pending = client.request("config/read", {});
  const rejected = assert.rejects(pending, (error) =>
    /Codex app-server exited/.test(error.message) && !error.message.includes(marker));
  process.kill(client.pid, "SIGKILL");
  await rejected;
});
