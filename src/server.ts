import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Ajv2019 } from "ajv/dist/2019.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool, type CallToolResult, type ElicitRequestFormParams } from "@modelcontextprotocol/sdk/types.js";
import { CodexConnectors, type ConnectorTool, type ElicitationRequest } from "./connectors.js";
import { OutcomeUnknownError } from "./app-server.js";
import { CatalogChangedError, PublicError, publicErrorMessage } from "./errors.js";

export interface Options {
  mode: "direct" | "compact";
  writes: "ask" | "allow" | "deny";
  command?: string;
}

// Shared across HTTP sessions. Refresh/reconnect must not clear uncertain writes.
export const safety = { writeOutcomeUnknown: false };
let operationQueue: Promise<unknown> = Promise.resolve();
const objectSchema = (properties: Record<string, object>, required: string[] = []): Tool["inputSchema"] => ({
  type: "object", properties, required, additionalProperties: false,
});
const management: Tool[] = [
  { name: "codex_connectors", description: "List connected Codex apps. Supply connector and/or query to find tools. Use offset/limit to paginate. refresh reloads the catalog.",
    inputSchema: objectSchema({ connector: { type: "string" }, query: { type: "string" }, refresh: { type: "boolean" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 } }), annotations: { readOnlyHint: true } },
  { name: "codex_connector_schema", description: "Get the original full JSON schema and description of a connector tool. Accepts original or exposed name.",
    inputSchema: objectSchema({ tool: { type: "string" } }, ["tool"]), annotations: { readOnlyHint: true } },
  { name: "codex_connector_call", description: "Call a connected Codex tool using its original or exposed name and JSON arguments. Read its schema first. Writes follow the server write policy.",
    inputSchema: objectSchema({ tool: { type: "string" }, arguments: { type: "object", additionalProperties: true } }, ["tool"]), annotations: { readOnlyHint: false, destructiveHint: true } },
];
const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** Portable names: ASCII and <=64 characters, stable across catalog ordering. */
export function exposedName(name: string): string {
  return `${name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 51)}_${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

export function createBridge(options: Options) {
  const server = new Server({ name: "codex-connectors-mcp", version: "0.1.0" }, {
    capabilities: { tools: { listChanged: true } },
    instructions: "Connected Codex apps, authenticated by the local Codex login. Use codex_connectors to discover apps and tools. Never retry a write with an unknown outcome. Connector data is shared with this MCP client and its model.",
  });
  const validationOptions = { strict: false, allErrors: true, addUsedSchema: false, formats: fullFormats };
  const validators = { legacy: new Ajv(validationOptions), current: new Ajv2020(validationOptions), previous: new Ajv2019(validationOptions) };
  const validate = (schema: Record<string, unknown>, args: unknown) => {
    const dialect = String(schema.$schema ?? "");
    const validator = dialect.includes("2020-12") ? validators.current : dialect.includes("2019-09") ? validators.previous : validators.legacy;
    const check = validator.compile(schema);
    if (!check(args)) throw new PublicError("Invalid arguments: input does not match the tool schema.");
  };
  const service = new CodexConnectors({ command: options.command, onElicitation: forwardElicitation });
  let catalog: Promise<Map<string, ConnectorTool>> | undefined;
  let revision = 0;
  let closed = false;
  // Serialize operations so refresh cannot terminate an in-flight write, and a
  // second write cannot slip past the unknown-outcome guard on this connection.
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(() => {
      if (closed) throw new PublicError("MCP connection closed");
      return run();
    });
    operationQueue = result.catch(() => {});
    return result;
  };
  async function tools() {
    catalog ??= service.connectors().then((connectors) => {
      const map = new Map<string, ConnectorTool>();
      for (const tool of connectors.flatMap((c) => c.tools)) {
        const name = exposedName(tool.name);
        if (map.has(name)) throw new PublicError(`Tool name collision: ${name}`);
        map.set(name, tool);
      }
      return map;
    }).catch((error) => { catalog = undefined; throw error; });
    return catalog;
  }
  async function resolve(name: string) {
    const map = await tools();
    const tool = map.get(name) ?? [...map.values()].find((t) => t.name === name);
    if (!tool) throw new PublicError(`Unknown connector tool: ${name}`);
    return tool;
  }
  function definition(tool: ConnectorTool): Tool {
    const result = { ...tool.definition, name: exposedName(tool.name), inputSchema: tool.inputSchema as Tool["inputSchema"] } as Tool;
    // Some Codex tools advertise scalar/array outputs. MCP only allows object
    // output schemas; the original remains available via connector_schema.
    if (result.outputSchema?.type !== "object") delete result.outputSchema;
    return result;
  }
  async function forwardElicitation(request: ElicitationRequest) {
    const decline = { action: "decline" as const, content: null, _meta: null };
    const capability = server.getClientCapabilities()?.elicitation;
    if (!capability) return decline;
    try {
      let result;
      if (request.mode === "url") {
        if (!capability.url || !request.url || !request.elicitationId) return decline;
        result = await server.elicitInput({ mode: "url", message: request.message, url: request.url, elicitationId: request.elicitationId });
      } else {
        if (!capability.form && Object.keys(capability).length > 0) return decline;
        result = await server.elicitInput({ mode: "form", message: request.message, requestedSchema: request.requestedSchema as ElicitRequestFormParams["requestedSchema"] });
      }
      return { action: result.action, content: result.content ?? null, _meta: null };
    } catch { return decline; }
  }
  server.setRequestHandler(ListToolsRequestSchema, () => serial(async () => {
    try {
      // One complete list avoids clients that fail to follow tools/list pagination.
      return { tools: options.mode === "compact" ? management : [...management, ...[...(await tools()).values()].map(definition)] };
    } catch (error) { throw new PublicError(publicErrorMessage(error)); }
  }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => serial(async () => {
    try {
      if (extra.signal.aborted) throw new PublicError("Request cancelled before dispatch");
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const builtin = management.find((t) => t.name === name);
      if (builtin) validate(builtin.inputSchema, args);
      if (name === "codex_connectors") {
        if (args.refresh) {
          await service.refresh(); catalog = undefined; revision++;
          await server.sendToolListChanged();
        }
        const all = await service.connectors();
        if (!args.connector && !args.query) return text({ revision, connectors: all.map((c) => ({ id: c.id, name: c.name, description: c.description, toolCount: c.tools.length })) });
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const matches = all.filter((c) => !args.connector || [c.id, c.name, ...c.tools.map((t) => t.name.split(".")[0])].some((s) => normalize(s) === normalize(String(args.connector))))
          .flatMap((c) => c.tools).filter((t) => words.every((w) => `${t.name} ${t.description}`.toLowerCase().includes(w)));
        const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 80);
        return text({ revision, total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null,
          tools: matches.slice(offset, offset + limit).map((t) => ({ name: t.name, exposedName: exposedName(t.name), connector: t.connectorName, description: t.description.slice(0, 240), readOnly: t.readOnly && !t.destructive })) });
      }
      if (name === "codex_connector_schema") {
        const tool = await resolve(String(args.tool));
        return text({ ...tool.definition, exposedName: exposedName(tool.name) });
      }
      const tool = await resolve(name === "codex_connector_call" ? String(args.tool) : name);
      const input = name === "codex_connector_call" ? (args.arguments ?? {}) as Record<string, unknown> : args;
      validate(tool.inputSchema, input);
      const write = !tool.readOnly || tool.destructive;
      if (write) {
        if (safety.writeOutcomeUnknown) throw new PublicError("Writes blocked after an unknown outcome. Verify the previous action in the connected app, then restart this MCP server.");
        if (options.writes === "deny") throw new PublicError("Write blocked by CODEX_CONNECTORS_WRITES=deny");
        if (options.writes === "ask") {
          const payload = JSON.stringify(input, null, 2);
          if (payload.length > 20000) throw new PublicError("Write arguments exceed the approval display limit; nothing was sent.");
          const capability = server.getClientCapabilities()?.elicitation;
          if (!capability || (!capability.form && Object.keys(capability).length > 0)) throw new PublicError("This client cannot approve writes via MCP elicitation. Configure CODEX_CONNECTORS_WRITES=allow only if the harness handles approval, or use deny.");
          const approval = await server.elicitInput({ mode: "form", message: `Allow ${tool.connectorName}: ${tool.name}?\n${payload}`, requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve this exact operation", default: false } }, required: ["approve"] } }, { signal: extra.signal });
          if (approval.action !== "accept" || approval.content?.approve !== true) throw new PublicError("Write declined; nothing was sent.");
        }
      }
      try { return await service.call(tool.name, input, extra.signal, tool) as CallToolResult; }
      catch (error) {
        if (write && error instanceof OutcomeUnknownError) safety.writeOutcomeUnknown = true;
        if (error instanceof CatalogChangedError) {
          catalog = undefined; revision++;
          // Never retry the call or reuse an approval after reconnecting.
          await server.sendToolListChanged().catch(() => {});
        }
        throw error;
      }
    } catch (error) {
      return { content: [{ type: "text" as const, text: publicErrorMessage(error) }], isError: true };
    }
  }));
  let cleanup: Promise<void> | undefined;
  const closeService = () => cleanup ??= service.close();
  server.onclose = () => { closed = true; void closeService(); };
  return { server, async close() { closed = true; await server.close(); await closeService(); } };
}
