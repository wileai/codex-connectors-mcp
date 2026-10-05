/** Public retrieval and a harmless Calculator read. No connector/UI mutations. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CodexComputerUse } from "../dist/computer-use.js";

async function stdio(env, capabilities = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/cli.js"), "--mode", "compact"], env: { ...process.env, CODEX_CONNECTORS_WRITES: "deny", ...env }, stderr: "pipe" });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "builtin-live-scenario", version: "1" }, { capabilities });
  try { await client.connect(transport); return client; } catch (error) { await transport.close(); throw error; }
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
const success = (result) => { assert.ok(!result.isError, result.content?.find((c) => c.type === "text")?.text); return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"); };
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function descendants(pid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((row) => row.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]);
  let changed = true;
  while (changed) { changed = false; for (const [child, parent] of rows) if (owned.has(parent) && !owned.has(child)) { owned.add(child); changed = true; } }
  return [...owned].filter((child) => child !== pid);
}
async function exited(pids) {
  const deadline = Date.now() + 10000;
  while (pids.some(running)) { assert.ok(Date.now() < deadline, "Computer Use descendants survived cleanup"); await new Promise((resolve) => setTimeout(resolve, 50)); }
}

for (const mode of ["cached", "indexed", "live"]) {
  test(`live MCP retrieval: ${mode}, open, find and follow a result link`, { timeout: 240_000 }, async (t) => {
    const client = await stdio({ CODEX_CONNECTORS_WEB_SEARCH: mode, CODEX_CONNECTORS_COMPUTER: "disabled" });
    t.after(() => client.close());
    const output = success(await call(client, "codex_web_search", {
      search_query: [{ q: "OpenAI Codex web search documentation" }], allowed_domains: ["developers.openai.com", "learn.chatgpt.com"],
    }));
    assert.match(output, /https:\/\//);
    const ref = /turn\d+search\d+/.exec(output)?.[0]; assert.ok(ref, "no search reference");
    const opened = success(await call(client, "codex_web_search", { open: [{ ref_id: ref }] }));
    assert.match(opened, /Content type:|Total lines:/);
    const pageRef = /turn\d+view\d+/.exec(opened)?.[0] ?? ref;
    assert.match(success(await call(client, "codex_web_search", { find: [{ ref_id: pageRef, pattern: "Codex" }] })), /Codex/);
    // Use a known compact documentation page for link checks; search rankings
    // can select huge pages whose rendered link IDs are rejected upstream.
    const linkedPage = success(await call(client, "codex_web_search", { open: [{ ref_id: "https://developers.openai.com/codex/mcp/" }] }));
    const linkRef = /turn\d+view\d+/.exec(linkedPage)?.[0];
    const link = /[【\[]\s*(\d+)†/.exec(linkedPage);
    assert.ok(linkRef && link, "opened documentation page has no link reference");
    assert.match(success(await call(client, "codex_web_search", { click: [{ ref_id: linkRef, id: Number(link[1]) }] })), /Content type:|Total lines:|https:\/\//);
    t.diagnostic("Public query, reference open/find/click succeeded; no model turn or connector discovery.");
  });
}

const probe = new CodexComputerUse("auto");
const available = probe.status().available;
await probe.close();
test("live MCP Computer Use: automatic discovery, persistent JS, app read, screenshot forwarding and reset", { skip: !available, timeout: 180_000 }, async (t) => {
  const client = await stdio({ CODEX_CONNECTORS_WEB_SEARCH: "disabled", CODEX_CONNECTORS_COMPUTER: "auto" }, { elicitation: { form: {} } });
  t.after(() => client.close());
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    prompts++;
    assert.match(request.params.message, /Computer Use app access/);
    assert.ok(request.params.requestedSchema.properties.approval.enum.includes("once"));
    return { action: "accept", content: { approval: "once" } };
  });
  assert.ok((await client.listTools()).tools.find((tool) => tool.name === "codex_computer_js"));
  assert.equal(JSON.parse(success(await call(client, "codex_computer_status"))).available, true);
  success(await call(client, "codex_computer_js", { code: "var smokeValue = 42; nodeRepl.write(String(smokeValue));", title: "Verify persistent JavaScript" }));
  assert.match(success(await call(client, "codex_computer_js", { code: "nodeRepl.write(String(smokeValue));" })), /42/);
  const screenshot = await call(client, "codex_computer_js", {
    code: "var sky = (await import('@oai/sky')).sky; var state = await sky.get_app_state({app:'com.apple.calculator',disableDiff:true}); nodeRepl.write('Calculator state characters: '+String(state.text.length)); if(state.screenshot){var bytes=await(await import('node:fs/promises')).readFile(new URL(state.screenshot.url)); await nodeRepl.emitImage({bytes,mimeType:bytes[0]===255?'image/jpeg':'image/png'});}",
    title: "Read Calculator state and screenshot",
  });
  assert.match(success(screenshot), /Calculator state characters: [1-9]/);
  assert.ok(screenshot.content.some((c) => c.type === "image" && c.data.length > 0), "native screenshot did not reach MCP");
  success(await call(client, "codex_computer_js_reset"));
  assert.match(success(await call(client, "codex_computer_js", { code: "nodeRepl.write(typeof smokeValue);" })), /undefined/);
  const runtimePids = descendants(client.transport.pid);
  assert.ok(runtimePids.length > 0);
  await client.close(); await exited(runtimePids);
  t.diagnostic(`Desktop runtime, JS state, Calculator accessibility/screenshot, reset passed; ${prompts} MCP app access prompts.`);
});

test("live HTTP builtins: independent web references and desktop JavaScript state, DELETE cleanup", { timeout: 180_000 }, async (t) => {
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [resolve("dist/cli.js"), "--transport", "http", "--port", "0", "--mode", "compact"], {
    env: { ...process.env, CODEX_CONNECTORS_HTTP_TOKEN: token, CODEX_CONNECTORS_WEB_SEARCH: "cached", CODEX_CONNECTORS_COMPUTER: "auto", CODEX_CONNECTORS_WRITES: "deny" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HTTP startup timed out")), 10000);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("HTTP exited during startup")); });
    child.stderr.on("data", (data) => { const match = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(String(data)); if (match) { clearTimeout(timer); resolve(new URL(match[0])); } });
  });
  const sessions = [];
  t.after(async () => { for (const session of sessions) await session.client.close(); });
  for (let index = 0; index < 2; index++) {
    const client = new Client({ name: `http-builtins-${index}`, version: "1" });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    await client.connect(transport); sessions.push({ client, transport });
    assert.ok((await client.listTools()).tools.find(({ name }) => name === "codex_web_search"));
    const query = success(await call(client, "codex_web_search", { search_query: [{ q: "OpenAI Codex MCP documentation" }] }));
    const ref = /turn\d+search\d+/.exec(query)?.[0]; assert.ok(ref);
    assert.match(success(await call(client, "codex_web_search", { open: [{ ref_id: ref }] })), /Content type:|Total lines:/);
  }
  if (available) {
    success(await call(sessions[0].client, "codex_computer_js", { code: "var httpSessionSentinel = 73; nodeRepl.write(String(httpSessionSentinel));" }));
    assert.match(success(await call(sessions[1].client, "codex_computer_js", { code: "nodeRepl.write(typeof httpSessionSentinel);" })), /undefined/);
    assert.match(success(await call(sessions[0].client, "codex_computer_js", { code: "nodeRepl.write(String(httpSessionSentinel));" })), /73/);
  }
  const runtimePids = descendants(child.pid);
  await sessions[0].transport.terminateSession();
  assert.ok((await sessions[1].client.listTools()).tools.find(({ name }) => name === "codex_web_search"));
  if (available) assert.match(success(await call(sessions[1].client, "codex_computer_js", { code: "nodeRepl.write('second session alive');" })), /second session alive/);
  await sessions[1].transport.terminateSession();
  child.kill("SIGTERM"); await once(child, "exit"); assert.equal(child.exitCode, 0);
  await exited(runtimePids);
});
