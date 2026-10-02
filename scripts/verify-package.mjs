import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "codex-connectors-package-"));
const npm = (args, cwd = root) => execFileSync("npm", args, { cwd, encoding: "utf8", timeout: 120_000 });
let client;
try {
  const [packed] = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]));
  const files = packed.files.map(({ path }) => path);
  for (const file of ["package.json", "dist/cli.js", "dist/server.js", "LICENSE", "NOTICE", "README.md"]) {
    assert.ok(files.includes(file), `Missing package file: ${file}`);
  }
  assert.ok(files.every((file) => /^(dist\/[^/]+\.(js|d\.ts)|package\.json|README\.md|RELEASING\.md|LICENSE|NOTICE)$/.test(file)), "Unexpected file in package");
  npm(["install", "--prefix", temporary, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(temporary, packed.filename)], temporary);
  const executable = join(temporary, "node_modules", ".bin", "codex-connectors-mcp");
  const help = execFileSync(executable, ["--help"], { cwd: temporary, encoding: "utf8", timeout: 10_000 });
  assert.match(help, /codex-connectors-mcp/);
  const transport = new StdioClientTransport({
    command: executable,
    args: ["--mode", "compact"],
    cwd: temporary,
    env: { ...process.env, CODEX_HOME: join(temporary, "unused-codex-home"), CODEX_CONNECTORS_CODEX: join(temporary, "no-codex-required"), CODEX_CONNECTORS_WRITES: "deny" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  client = new Client({ name: "package-verification", version: "1.0.0" });
  await client.connect(transport, { timeout: 15_000 });
  const expected = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(client.getServerVersion().version, expected.version);
  assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), ["codex_connectors", "codex_connector_schema", "codex_connector_call"]);
  console.log(`Package verified: ${packed.name}@${packed.version}; executable, MCP handshake, discovery, and file allowlist passed.`);
} finally {
  await client?.close();
  rmSync(temporary, { recursive: true, force: true });
}
