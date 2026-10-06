import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const cli = resolve("dist/cli.js");
const requestOptions = { timeout: 180_000 };
const parse = (result) => { assert.ok(!result.isError, result.content?.[0]?.text); return JSON.parse(result.content[0].text); };
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, requestOptions);
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Process cleanup timed out"); await new Promise((r) => setTimeout(r, 50)); }
}
function children(pid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  return rows.trim().split("\n").map((r) => r.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === pid).map(([child]) => child);
}
async function stdio(env = {}, capabilities = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env: { ...process.env, CODEX_CONNECTORS_WRITES: "deny", CODEX_CONNECTORS_WEB_SEARCH: "disabled", CODEX_CONNECTORS_COMPUTER: "disabled", ...env }, stderr: "pipe" });
  transport.stderr.on("data", () => {});
  const client = new Client({ name: "live-mcp-scenario", version: "1" }, { capabilities });
  try { await client.connect(transport); return { client, transport }; }
  catch (error) { await transport.close(); throw error; }
}

test("stdio direct: complete discovery, real read, validation, write denial, refresh and cleanup", { timeout: 300_000 }, async (t) => {
  const { client, transport } = await stdio();
  t.after(() => client.close());
  const listed = await client.listTools({}, requestOptions);
  const catalog = parse(await call(client, "codex_connectors"));
  assert.ok(catalog.connectors.length > 0);
  assert.equal(listed.tools.length, catalog.connectors.reduce((n, c) => n + c.toolCount, 0) + 4);
  assert.equal(new Set(listed.tools.map((t) => t.name)).size, listed.tools.length);
  assert.ok(listed.tools.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name)));
  t.diagnostic(`${catalog.connectors.length} connected apps; ${listed.tools.length - 4} connector tools`);
  const profile = listed.tools.find((t) => t.name.startsWith("github_get_profile_"));
  assert.ok(profile, "Live scenario requires GitHub connected");
  const schema = parse(await call(client, "codex_connector_schema", { tool: profile.name }));
  assert.equal(schema.name, "github.get_profile");
  assert.deepEqual(schema.inputSchema, profile.inputSchema);
  const result = await call(client, profile.name);
  assert.ok(!result.isError, result.content?.[0]?.text);
  assert.ok(result.content.length > 0 || result.structuredContent);
  const wrapped = await call(client, "codex_connector_call", { tool: schema.name, arguments: {} });
  assert.ok(!wrapped.isError);
  // Exercise a real draft-2020 schema, without revealing profile data in logs.
  const figma = listed.tools.find((t) => t.name.startsWith("figma_whoami_"));
  if (figma) assert.ok(!(await call(client, figma.name)).isError);
  const invalid = await call(client, "codex_connector_schema", {});
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Invalid arguments/);
  const unknown = await call(client, "not_a_connector_tool");
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown connector tool/);
  const write = listed.tools.find((t) => t.name.startsWith("instacart_open_home_"));
  assert.ok(write, "Live denial scenario requires Instacart open_home");
  const denied = await call(client, write.name);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /WRITES=deny/);
  let notified = false;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notified = true; });
  const appPids = children(transport.pid);
  assert.ok(appPids.length);
  parse(await call(client, "codex_connectors", { refresh: true }));
  await until(() => notified && appPids.every((pid) => !running(pid)));
  const refreshed = await client.listTools({}, requestOptions);
  assert.deepEqual(refreshed.tools.map((t) => t.name), listed.tools.map((t) => t.name));
  const remaining = children(transport.pid);
  const parent = transport.pid;
  await client.close();
  await until(() => !running(parent) && remaining.every((pid) => !running(pid)));
});

test("compact: management tools, pagination, allowlist, read, and unavailable write approval", { timeout: 240_000 }, async (t) => {
  const { client } = await stdio({ CODEX_CONNECTORS_MODE: "compact", CODEX_CONNECTORS_WRITES: "ask", CODEX_CONNECTORS_ALLOW: "GitHub,Instacart" });
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools.length, 4);
  const catalog = parse(await call(client, "codex_connectors"));
  assert.ok(catalog.connectors.every((c) => ["GitHub", "Instacart"].includes(c.name)));
  const first = parse(await call(client, "codex_connectors", { connector: "GitHub", limit: 1 }));
  const next = parse(await call(client, "codex_connectors", { connector: "GitHub", limit: 1, offset: first.nextOffset }));
  assert.equal(first.tools.length, 1);
  assert.notEqual(first.tools[0].name, next.tools[0].name);
  assert.ok(!(await call(client, "codex_connector_call", { tool: "github.get_profile" })).isError);
  const blocked = await call(client, "codex_connector_call", { tool: "instacart.open_home" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /cannot approve writes/);
  const excluded = await call(client, "codex_connector_schema", { tool: "figma.whoami" });
  assert.equal(excluded.isError, true);
});

test("ask: write approval travels over MCP and declining prevents dispatch", { timeout: 180_000 }, async (t) => {
  const { client } = await stdio({ CODEX_CONNECTORS_WRITES: "ask", CODEX_CONNECTORS_ALLOW: "Instacart" }, { elicitation: { form: {} } });
  t.after(() => client.close());
  let asked = false;
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    asked = true;
    assert.match(request.params.message, /instacart.open_home/);
    return { action: "decline" };
  });
  const result = await call(client, "codex_connector_call", { tool: "instacart.open_home" });
  assert.equal(asked, true);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Write declined/);
});

test("empty allowlist exposes no connectors and cannot call excluded tools", { timeout: 180_000 }, async (t) => {
  const { client } = await stdio({ CODEX_CONNECTORS_ALLOW: "" });
  t.after(() => client.close());
  assert.equal((await client.listTools({}, requestOptions)).tools.length, 4);
  assert.deepEqual(parse(await call(client, "codex_connectors")).connectors, []);
  assert.equal((await call(client, "codex_connector_call", { tool: "github.get_profile" })).isError, true);
});

test("HTTP: authentication, origin checks, independent sessions, real read, DELETE and shutdown", { timeout: 240_000 }, async (t) => {
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [cli, "--transport", "http", "--port", "0", "--mode", "compact"], {
    env: { ...process.env, CODEX_CONNECTORS_WEB_SEARCH: "disabled", CODEX_CONNECTORS_COMPUTER: "disabled", CODEX_CONNECTORS_HTTP_TOKEN: token, CODEX_CONNECTORS_WRITES: "deny", CODEX_CONNECTORS_ALLOW: "GitHub" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("HTTP startup timed out")), 10_000);
    child.once("exit", () => { clearTimeout(timeout); reject(new Error("HTTP exited during startup")); });
    child.stderr.on("data", (data) => { const match = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(String(data)); if (match) { clearTimeout(timeout); resolve(new URL(match[0])); } });
  });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}`, origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}`, "mcp-session-id": "missing" } })).status, 404);
  const clients = [];
  t.after(async () => { for (const { client } of clients) await client.close(); });
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: `http-scenario-${i}`, version: "1" });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    await client.connect(transport); clients.push({ client, transport });
  }
  assert.notEqual(clients[0].transport.sessionId, clients[1].transport.sessionId);
  for (const { client } of clients) {
    assert.equal((await client.listTools()).tools.length, 4);
    assert.ok(!(await call(client, "codex_connector_call", { tool: "github.get_profile" })).isError);
  }
  const appPids = children(child.pid);
  const deletedId = clients[0].transport.sessionId;
  await clients[0].transport.terminateSession();
  assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}`, "mcp-session-id": deletedId } })).status, 404);
  assert.ok(!(await call(clients[1].client, "codex_connector_call", { tool: "github.get_profile" })).isError);
  for (const { transport, client } of clients) { await transport.terminateSession(); await client.close(); }
  await until(() => appPids.every((pid) => !running(pid)));
  child.kill("SIGTERM"); await once(child, "exit");
  assert.equal(child.exitCode, 0);
});


test("reconnect: reject stale authorization, notify, then allow a fresh read", { timeout: 180_000 }, async (t) => {
  const { client, transport } = await stdio({ CODEX_CONNECTORS_ALLOW: "GitHub" });
  t.after(() => client.close());
  const listed = await client.listTools({}, requestOptions);
  const profile = listed.tools.find((tool) => tool.name.startsWith("github_get_profile_"));
  assert.ok(profile);
  let notified = false;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notified = true; });
  const appPids = children(transport.pid);
  assert.equal(appPids.length, 1);
  process.kill(appPids[0], "SIGKILL");
  await until(() => !running(appPids[0]));
  // Even an unchanged tool must not reuse authorization from the old session.
  const stale = await call(client, profile.name);
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /catalog changed before dispatch; nothing was sent/);
  await until(() => notified);
  assert.ok((await client.listTools({}, requestOptions)).tools.some((tool) => tool.name === profile.name));
  assert.equal((await call(client, profile.name)).isError, false);
});

test("missing executable diagnostics never disclose its private path over MCP", async (t) => {
  const marker = "private-path-audit-sentinel";
  const { client } = await stdio({ CODEX_CONNECTORS_CODEX: `/nonexistent/${marker}` });
  t.after(() => client.close());
  await assert.rejects(client.listTools({}, requestOptions), (error) =>
    /failed to start/.test(error.message) && !error.message.includes(marker));
  const result = await call(client, "codex_connectors");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /failed to start/);
  assert.ok(!JSON.stringify(result).includes(marker));
});
