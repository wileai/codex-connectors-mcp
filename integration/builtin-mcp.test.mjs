import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CodexComputerUse } from "../dist/computer-use.js";
import { createBridge, safety } from "../dist/server.js";

async function connect(options, capabilities = {}) {
  const bridge = createBridge({ mode: "compact", writes: "deny", computer: "disabled", ...options });
  const client = new Client({ name: "builtin-mcp-test", version: "1" }, { capabilities });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverTransport); await client.connect(clientTransport);
  return { client, async close() { await client.close(); await bridge.close(); } };
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

test("MCP builtins: discovery/schema/dispatcher, retrieval, validation and maximum modes without a connector thread", async () => {
  const bridge = await connect({ command: resolve("integration/fixtures/search-auth.mjs"), webSearch: "cached" });
  const http = mock.method(globalThis, "fetch", async () => Response.json({ output: "Public result https://example.com [turn0search0]", encrypted_output: "PRIVATE_SENTINEL" }));
  try {
    const { tools } = await bridge.client.listTools();
    assert.equal(tools.length, 5); assert.ok(tools.find(({ name }) => name === "codex_web_search"));
    const schema = await call(bridge.client, "codex_connector_schema", { tool: "codex_web_search" });
    assert.deepEqual(JSON.parse(schema.content[0].text).inputSchema, tools.find(({ name }) => name === "codex_web_search").inputSchema);
    for (const name of ["codex_web_search", "codex_connector_call"]) {
      const query = { search_query: [{ q: "public documentation" }] };
      const result = await call(bridge.client, name, name === "codex_connector_call" ? { tool: "codex_web_search", arguments: query } : query);
      assert.ok(!result.isError); assert.match(result.content[0].text, /https:\/\/example.com/);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_SENTINEL"));
    }
    assert.equal(http.mock.callCount(), 2);
    for (const args of [{}, { search_query: [{ q: "" }] }, { search_query: [{ q: "test" }], mode: "live" }, { search_query: [{ q: "test" }], endpoint: "https://bad.invalid" }]) {
      assert.equal((await call(bridge.client, "codex_web_search", args)).isError, true);
    }
    assert.equal(http.mock.callCount(), 2);
    assert.equal(JSON.parse((await call(bridge.client, "codex_computer_status")).content[0].text).available, false);
    assert.match((await call(bridge.client, "codex_computer_js", { code: "1" })).content[0].text, /disabled/);
  } finally { mock.restoreAll(); await bridge.close(); }
  const disabled = await connect({ command: "/missing/codex", webSearch: "disabled" });
  try {
    assert.equal((await disabled.client.listTools()).tools.length, 4);
    assert.match((await call(disabled.client, "codex_web_search", { search_query: [{ q: "test" }] })).content[0].text, /disabled/);
  } finally { await disabled.close(); }
});

test("MCP computer: native app approvals, persisted grants, content preservation, missing client support and process-wide uncertainty guard", { skip: process.platform !== "darwin" }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "mcp-runtime-fixture-"));
  const previousApp = process.env.CODEX_CONNECTORS_COMPUTER_APP, previousHome = process.env.CODEX_HOME;
  const root = join(temporary, "Contents/Resources/cua_node");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "lib/node_modules/@oai/sky"), { recursive: true });
  mkdirSync(join(root, "lib/node_modules/@oai/cua-repl/bin"), { recursive: true });
  symlinkSync(process.execPath, join(root, "bin/node")); writeFileSync(join(root, "bin/node_repl"), "");
  writeFileSync(join(root, "lib/node_modules/@oai/sky/package.json"), JSON.stringify({ version: "synthetic" }));
  writeFileSync(join(root, "lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs"), `
    import {createInterface} from 'node:readline';let call;
    const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));
    for await(const line of createInterface({input:process.stdin})){const x=JSON.parse(line);
      if(x.method==='initialize')send({id:x.id,result:{}});
      if(x.method==='tools/call'){call=x.id;if(x.params.arguments.code==='crash'){process.exit(1)}
        send({id:'native-approval',method:'elicitation/create',params:{message:'Synthetic app access',_meta:{connector_id:'computer-use',persist:['session','always'],tool_params:{app:'test.synthetic'}}}});}
      if(x.id==='native-approval')send({id:call,result:{content:[{type:'text',text:x.result.action},{type:'image',data:'AA==',mimeType:'image/png'}],isError:x.result.action!=='accept'}});
    }`);
  process.env.CODEX_CONNECTORS_COMPUTER_APP = temporary; process.env.CODEX_HOME = join(temporary, "codex-home");
  let bridge, next;
  try {
    await verifyComputerWritePolicy();
    bridge = await connect({ computer: "auto", webSearch: "disabled", writes: "allow" }, { elicitation: { form: {} } });
    let prompts = 0, choice = "always";
    bridge.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      prompts++; assert.ok(request.params.requestedSchema.properties.approval.enum.includes("always"));
      return { action: "accept", content: { approval: choice } };
    });
    assert.equal((await bridge.client.listTools()).tools.length, 7);
    let result = await call(bridge.client, "codex_computer_js", { code: "synthetic" });
    assert.equal(result.isError, false); assert.equal(result.content[1].type, "image"); assert.equal(prompts, 1);
    assert.equal((await call(bridge.client, "codex_computer_js", { code: "synthetic" })).isError, false); assert.equal(prompts, 1);
    await bridge.close(); bridge = undefined;
    next = await connect({ computer: "auto", webSearch: "disabled", writes: "allow" });
    assert.equal((await call(next.client, "codex_computer_js", { code: "synthetic" })).isError, false, "saved app grant works across sessions without elicitation");
    assert.ok(!(await call(next.client, "codex_computer_forget")).isError);
    result = await call(next.client, "codex_computer_js", { code: "synthetic" });
    assert.equal(result.isError, true); assert.equal(result.content[0].text, "decline", "headless access without a saved grant is declined");
    const crashed = await call(next.client, "codex_computer_js", { code: "crash" });
    assert.equal(crashed.isError, true); assert.match(crashed.content[0].text, /disconnected/);
    await next.close(); next = await connect({ computer: "auto", webSearch: "disabled" });
    for (const name of ["codex_computer_js", "codex_computer_js_reset"]) {
      assert.match((await call(next.client, name, name.endsWith("_js") ? { code: "synthetic" } : {})).content[0].text, /blocked after an unknown outcome/);
    }
  } finally {
    await bridge?.close(); await next?.close(); safety.computerOutcomeUnknown = false;
    if (previousApp === undefined) delete process.env.CODEX_CONNECTORS_COMPUTER_APP; else process.env.CODEX_CONNECTORS_COMPUTER_APP = previousApp;
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    rmSync(temporary, { recursive: true, force: true });
  }
});


async function verifyComputerWritePolicy() {
  const dispatch = mock.method(CodexComputerUse.prototype, "call", async () => ({ content: [{ type: "text", text: "executed" }] }));
  try {
    for (const writes of ["deny", "ask", "allow"]) {
      for (const elicitation of [false, true]) {
        const bridge = await connect({ computer: "auto", writes }, elicitation ? { elicitation: { form: {} } } : {});
        let prompts = 0, approve = false;
        if (elicitation) bridge.client.setRequestHandler(ElicitRequestSchema, async (request) => {
          prompts++;
          assert.match(request.params.message, /Computer Use: codex_computer_js/);
          if (request.params.message.includes('"code"')) {
            assert.ok(request.params.message.includes('"title": "Policy probe"'));
            assert.ok(request.params.message.includes('"code": "nodeRepl.write(42)"'));
          }
          return { action: "accept", content: { approve } };
        });
        try {
          for (const name of ["codex_computer_js", "codex_computer_js_reset"]) {
            for (const route of [name, "codex_connector_call"]) {
              const args = name.endsWith("_js") ? { code: "nodeRepl.write(42)", title: "Policy probe" } : {};
              for (approve of [false, true]) {
                const before = dispatch.mock.callCount();
                const result = await call(bridge.client, route, route === name ? args : { tool: name, arguments: args });
                const allowed = writes === "allow" || (writes === "ask" && elicitation && approve);
                assert.equal(!result.isError, allowed);
                assert.equal(dispatch.mock.callCount() - before, allowed ? 1 : 0);
              }
            }
          }
          assert.equal(prompts, writes === "ask" && elicitation ? 8 : 0);
        } finally { await bridge.close(); }
      }
    }
  } finally { mock.restoreAll(); }
}
