import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppApprovals } from "../dist/computer-permissions.js";
import { ComputerBridge, ComputerOutcomeUnknownError } from "../dist/computer-bridge.js";
import { CodexComputerUse, computerMode } from "../dist/computer-use.js";

test("app approvals: once, session, forever, native restrictions, denial, cancellation, revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-computer-approvals-"));
  const file = join(dir, "approvals.json");
  let calls = 0, choice = "once";
  const prompt = async (_request, choices) => { calls++; assert.ok(choices.includes("deny")); return choice; };
  const request = { message: "Synthetic app", _meta: { connector_id: "computer-use", persist: ["session", "always"], tool_params: { app: "test.synthetic" } } };
  const signal = new AbortController().signal;
  try {
    let approvals = new AppApprovals(file);
    assert.equal((await approvals.confirm(prompt, request, signal)).action, "accept");
    await approvals.confirm(prompt, request, signal); assert.equal(calls, 2, "once does not persist");
    choice = "session";
    await approvals.confirm(prompt, request, signal);
    await approvals.confirm(undefined, request, signal); assert.equal(calls, 3);
    approvals.clearSession(); choice = "deny";
    assert.equal((await approvals.confirm(prompt, request, signal)).action, "decline");
    choice = "always";
    assert.equal((await approvals.confirm(prompt, request, signal))._meta.persist, "always");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    approvals = new AppApprovals(file);
    assert.equal((await approvals.confirm(undefined, request, signal)).action, "accept");
    assert.equal((await approvals.confirm(undefined, { ...request, _meta: { ...request._meta, persist: ["session"] } }, signal)).action, "decline");
    assert.equal((await approvals.confirm(undefined, { ...request, _meta: { ...request._meta, connector_id: "other" } }, signal)).action, "decline");
    assert.equal((await approvals.confirm(undefined, { ...request, _meta: { ...request._meta, tool_params: { app: "other.app" } } }, signal)).action, "decline");
    approvals.forget(); assert.equal((await approvals.confirm(undefined, request, signal)).action, "decline");
    assert.equal((await approvals.confirm(prompt, { ...request, requestedSchema: { properties: { password: {} } } }, signal)).action, "decline");
    assert.equal((await approvals.confirm(prompt, request, AbortSignal.abort())).action, "decline");
    assert.equal((await approvals.confirm(prompt, { ...request, mode: "url" }, signal)).action, "decline");
    choice = "always";
    assert.equal((await approvals.confirm(prompt, { ...request, _meta: { ...request._meta, persist: [] } }, signal)).action, "decline", "cannot override native persistence policy");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const peer = `const rl=require('node:readline').createInterface({input:process.stdin});let call;const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));rl.on('line',line=>{const x=JSON.parse(line);if(x.method==='initialize')send({id:x.id,result:{form:!!x.params.capabilities.elicitation.form}});if(x.method==='tools/call'){call=x.id;send({id:'approval',method:'elicitation/create',params:{message:'Synthetic only'}});}if(x.id==='approval')send({id:call,result:x.result});});`;
test("computer transport: MCP approval accept/decline/cancel, deadlines pause during approval", async () => {
  for (const action of ["accept", "decline", "cancel"]) {
    let prompts = 0;
    const bridge = await ComputerBridge.start(process.execPath, ["-e", peer], process.env, async () => {
      prompts++; await new Promise((resolve) => setTimeout(resolve, 80)); return { action };
    });
    try { assert.equal((await bridge.request("tools/call", {}, 40)).action, action); assert.equal(prompts, 1); }
    finally { await bridge.close(); }
  }
});

test("computer transport: cancellation and timeout report unknown dispatched outcomes and stop the child", async () => {
  const silent = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:x.id,result:{}}));});`;
  for (const cancel of [false, true]) {
    const bridge = await ComputerBridge.start(process.execPath, ["-e", silent], process.env, async () => ({ action: "decline" }));
    const abort = new AbortController();
    const result = assert.rejects(bridge.request("tools/call", {}, 100, abort.signal), (error) => error instanceof ComputerOutcomeUnknownError);
    if (cancel) abort.abort();
    await result; await bridge.close(); await bridge.close();
    await assert.rejects(bridge.request("tools/call", {}), /closed/);
  }
  await assert.rejects(ComputerBridge.start("/missing/private-computer-path", [], process.env, async () => ({ action: "decline" })), (error) => !error.message.includes("private-computer-path"));
  await assert.rejects(ComputerBridge.start(process.execPath, [], process.env, async () => ({ action: "decline" }), AbortSignal.abort()), /before dispatch/);
});

test("missing/disabled runtime leaves the bridge usable and reports its status", async () => {
  assert.throws(() => computerMode("force"), /auto or disabled/);
  const computer = new CodexComputerUse("auto", undefined, { ...process.env, CODEX_CONNECTORS_COMPUTER_APP: "/missing/private-runtime" });
  assert.equal(computer.status().available, false);
  assert.match(computer.status().reason, /requires macOS|runtime missing/);
  await assert.rejects(computer.call("js", { code: "1" }), /requires macOS|runtime missing/);
  await computer.close();
  const disabled = new CodexComputerUse("disabled");
  assert.match(disabled.status().reason, /disabled/); await disabled.close();
});
