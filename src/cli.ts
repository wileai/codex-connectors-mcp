#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createBridge, type Options } from "./server.js";
import { searchMode } from "./web-search.js";
import { computerMode } from "./computer-use.js";
import { PublicError, publicErrorMessage } from "./errors.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`codex-connectors-mcp [--transport stdio|http] [--port 8787] [--mode direct|compact]

CODEX_CONNECTORS_CODEX    Codex executable (default: codex)
CODEX_CONNECTORS_MODE     direct (all tools) or compact (discovery/call tools plus web/computer tools)
CODEX_CONNECTORS_WRITES   ask (default), allow, deny
CODEX_CONNECTORS_ALLOW    Optional comma-separated exact connector names/IDs
CODEX_CONNECTORS_WEB_SEARCH  disabled, cached (default), indexed, live (maximum access)
CODEX_CONNECTORS_WEB_SEARCH_MODEL  Retrieval routing model (default: gpt-5.4; no inference)
CODEX_CONNECTORS_COMPUTER  auto (default), disabled
CODEX_CONNECTORS_COMPUTER_APP  Desktop runtime path (default: /Applications/ChatGPT.app)
CODEX_CONNECTORS_HTTP_TOKEN  Required bearer token for HTTP (at least 32 characters)

Uses your existing Codex login. Connector data is shared with the MCP harness.
HTTP binds to 127.0.0.1 only. Endpoint: /mcp. No model turns are run.`);
    return;
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--transport", "--port", "--mode"].includes(args[i]) || !args[i + 1]) throw new PublicError(`Invalid option: ${args[i]}. Use --help.`);
    flags.set(args[i], args[i + 1]);
  }
  const transport = flags.get("--transport") ?? "stdio";
  const mode = flags.get("--mode") ?? process.env.CODEX_CONNECTORS_MODE ?? "direct";
  const writes = process.env.CODEX_CONNECTORS_WRITES ?? "ask";
  if (transport !== "stdio" && transport !== "http") throw new PublicError("transport must be stdio or http");
  if (mode !== "direct" && mode !== "compact") throw new PublicError("mode must be direct or compact");
  if (writes !== "ask" && writes !== "allow" && writes !== "deny") throw new PublicError("CODEX_CONNECTORS_WRITES must be ask, allow, or deny");
  const options: Options = { mode, writes, command: process.env.CODEX_CONNECTORS_CODEX, webSearch: searchMode(process.env.CODEX_CONNECTORS_WEB_SEARCH), computer: computerMode(process.env.CODEX_CONNECTORS_COMPUTER) };
  let shutdown: () => Promise<void>;
  if (transport === "stdio") {
    const bridge = createBridge(options);
    await bridge.server.connect(new StdioServerTransport());
    shutdown = () => bridge.close();
  } else {
    const port = Number(flags.get("--port") ?? 8787);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PublicError("Invalid port");
    const token = process.env.CODEX_CONNECTORS_HTTP_TOKEN;
    if (!token || token.length < 32) throw new PublicError("HTTP requires CODEX_CONNECTORS_HTTP_TOKEN with at least 32 characters");
    const expected = Buffer.from(`Bearer ${token}`);
    type Session = { bridge: ReturnType<typeof createBridge>; transport: StreamableHTTPServerTransport; touched: number; active: number };
    const sessions = new Map<string, Session>();
    const pending = new Set<Session>();
    const http = createServer(async (req, res) => {
      let created: Session | undefined;
      let current: Session | undefined;
      try {
        const auth = Buffer.from(req.headers.authorization ?? "");
        if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401).end("Unauthorized"); return; }
        if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
        const host = req.headers.host ?? "";
        if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { res.writeHead(403).end("Invalid Host"); return; }
        if (req.headers.origin && req.headers.origin !== `http://${host}`) { res.writeHead(403).end("Invalid Origin"); return; }
        let body: unknown;
        if (req.method === "POST") {
          if (!req.headers["content-type"]?.includes("application/json")) { res.writeHead(415).end(); return; }
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 4 * 1024 * 1024) { res.writeHead(413).end("Request too large"); return; }
            chunks.push(chunk);
          }
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { res.writeHead(400).end("Invalid JSON"); return; }
        }
        const sid = req.headers["mcp-session-id"];
        current = typeof sid === "string" ? sessions.get(sid) : undefined;
        if (!current && sid) { res.writeHead(404).end("Unknown MCP session"); return; }
        if (!current) {
          if (req.method !== "POST" || !isInitializeRequest(body)) { res.writeHead(400).end("Initialize an MCP session first"); return; }
          if (sessions.size + pending.size >= 16) { res.writeHead(503).end("Session limit reached"); return; }
          const bridge = createBridge(options);
          const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => { sessions.set(id, created!); pending.delete(created!); } });
          current = created = { bridge, transport: mcpTransport, touched: Date.now(), active: 0 };
          pending.add(created);
          await bridge.server.connect(mcpTransport);
          const onclose = bridge.server.onclose;
          bridge.server.onclose = () => { if (mcpTransport.sessionId) sessions.delete(mcpTransport.sessionId); pending.delete(created!); onclose?.(); };
        }
        current.touched = Date.now(); current.active++;
        await current.transport.handleRequest(req, res, body);
        if (created && !created.transport.sessionId) await created.bridge.close();
      } catch {
        if (created) await created.bridge.close();
        if (!res.headersSent) res.writeHead(500).end("MCP request failed");
      } finally { if (current) { current.active--; current.touched = Date.now(); } }
    });
    const sweep = setInterval(() => {
      for (const session of sessions.values()) {
        if (session.active === 0 && Date.now() - session.touched > 30 * 60_000) void session.bridge.close();
      }
    }, 60_000).unref();
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(port, "127.0.0.1", resolve); });
    const address = http.address();
    console.error(`Codex Connectors MCP listening at http://127.0.0.1:${typeof address === "object" && address ? address.port : port}/mcp`);
    shutdown = async () => {
      clearInterval(sweep);
      http.close();
      await Promise.all([...sessions.values(), ...pending].map((s) => s.bridge.close()));
      http.closeAllConnections();
    };
  }
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void shutdown().then(() => process.exit(0), () => process.exit(1));
  });
}
main().catch((error) => { console.error(publicErrorMessage(error)); process.exitCode = 1; });
