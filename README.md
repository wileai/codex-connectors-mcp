# codex-connectors-mcp

Use your connected Codex apps from any harness supporting **MCP stdio** or
**Streamable HTTP**. Codex owns authentication; the harness chooses the model.
No Codex model turn, API key, or Pi dependency is involved.

Website: **https://wileai.github.io/codex-connectors-mcp/**

## Quick start

Requires Node.js 22.19+ and a Codex CLI with `app/installed` and
`mcpServer/tool/call`. Verified with Codex CLI **0.159.3**.

```sh
codex login
```

Add this to your harness's MCP configuration (no clone or build required):

```json
{
  "mcpServers": {
    "codex-connectors": {
      "command": "npx",
      "args": ["-y", "codex-connectors-mcp@latest"],
      "env": {
        "CODEX_CONNECTORS_WRITES": "ask",
        "CODEX_CONNECTORS_ALLOW": "GitHub"
      }
    }
  }
}
```

`@latest` checks for the current stable version when the server starts; restart
your harness to pick up updates. Pin `codex-connectors-mcp@0.1.0` when you need
a fixed version. Prereleases are available through `@next`.

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.codex-connectors]
command = "npx"
args = ["-y", "codex-connectors-mcp@latest"]
startup_timeout_sec = 120
tool_timeout_sec = 180

[mcp_servers.codex-connectors.env]
CODEX_CONNECTORS_WRITES = "ask"
CODEX_CONNECTORS_ALLOW = "GitHub"
```

See the [Codex MCP configuration reference](https://developers.openai.com/codex/mcp/).
Other local workflow runners can use the same command, arguments, and environment.
They must support MCP stdio and have access to your authenticated Codex CLI.

If a desktop harness cannot find npx or Codex, use absolute executable paths
for `command` and `CODEX_CONNECTORS_CODEX`. The process must run as the user
whose Codex account has the apps connected. `CODEX_HOME` is inherited when set.
The example limits access to GitHub; set `CODEX_CONNECTORS_ALLOW` to the apps
you intend to share. Omitting it exposes all eligible connected apps.
Configuration containers differ between harnesses; use their equivalent MCP
server command/arguments/environment fields.

Installing/configuring this bridge authorizes sharing app names, tool schemas,
and tool results with that harness and its model provider. The bridge does not
read credentials itself or save connector responses to disk. This does not
guarantee that Codex, connected services, or the receiving harness retain no data.
Read-only tools can return private data; write denial does not prevent reads.

## Tools

**Direct mode (default):** every enabled, callable connector tool appears in
`tools/list`, with its complete input schema and provider annotations. Tools
have stable ASCII names capped at 64 characters, e.g.
`github_get_profile_3b5eaf4306c5`. These names work in clients that reject dots.

Three additional tools are available in either mode:

| Tool | Purpose |
| --- | --- |
| `codex_connectors` | List apps; filter tools by `connector` and/or `query`; paginate with `offset`/`limit`; reload with `refresh: true` |
| `codex_connector_schema` | Full original tool definition, plus its exposed name |
| `codex_connector_call` | Call by original or exposed name with an `arguments` object |

**Compact mode:** set `CODEX_CONNECTORS_MODE=compact` to expose only these three
tools. All eligible connector tools remain callable through the dispatcher.
Use this when a harness limits tool counts or hundreds of schemas cost too much
context. Example workflow:

```text
codex_connectors({"connector":"GitHub","query":"profile"})
codex_connector_schema({"tool":"github.get_profile"})
codex_connector_call({"tool":"github.get_profile","arguments":{}})
```

Only apps reported as enabled and callable by Codex are exposed, not the public
app marketplace or your separately configured MCP servers. This bridges tools;
it does not install associated plugin skills into the receiving harness.

## Writes

| `CODEX_CONNECTORS_WRITES` | Behavior |
| --- | --- |
| `ask` (default) | Request approval through MCP form elicitation, displaying the exact tool and arguments. Clients without elicitation cannot write. |
| `allow` | Let the receiving harness handle authorization; the bridge adds no write confirmation. |
| `deny` | Reject tools not marked read-only, and all tools marked destructive. |

For a harness that already confirms MCP calls but does not support elicitation,
set `CODEX_CONNECTORS_WRITES=allow`. That trusts the harness to approve actions.
Provider read-only annotations are hints, not independent proof of behavior.
Approval payloads over 20,000 characters fail without dispatch; they are never
silently shortened.

Connector-requested forms and URL elicitations are forwarded when supported by
the client and otherwise declined. Credentials remain under Codex's control.

Calls time out after 120 seconds. Cancellation, timeout, or app-server death
after dispatch can leave an **unknown outcome**: the remote operation may still
finish. Never automatically retry a write. An uncertain write blocks subsequent
writes across all sessions of this server process, including after catalog
refresh. Check the connected app before restarting. This guard is not durable
across process restarts or separate server instances.

After an app-server reconnection, a call using the old catalog is rejected before
dispatch and the client is notified to rediscover tools. Validation and approval
must use the new catalog; the bridge does not retry the rejected call.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_CONNECTORS_CODEX` | `codex` | Executable path |
| `CODEX_CONNECTORS_MODE` | `direct` | `direct` or `compact` |
| `CODEX_CONNECTORS_WRITES` | `ask` | `ask`, `allow`, or `deny` |
| `CODEX_CONNECTORS_ALLOW` | All eligible apps | Comma-separated exact connector names or IDs, case-insensitive; an explicitly empty value exposes none |
| `CODEX_CONNECTORS_HTTP_TOKEN` | Unset | Required HTTP bearer token, at least 32 characters |

CLI: `--transport stdio|http`, `--mode direct|compact`, `--port 8787`, `--help`.
Diagnostics use stderr; stdio stdout contains MCP messages only. Raw child stderr
is discarded, and upstream RPC errors are replaced with public diagnostics.
Unexpected internal errors are not sent to clients. Connector tool results
(including provider error results) are still forwarded as documented.

## Streamable HTTP

For clients using an MCP URL rather than a subprocess:

```sh
export CODEX_CONNECTORS_HTTP_TOKEN="$(openssl rand -hex 32)"
npx -y codex-connectors-mcp@latest --transport http --port 8787
```

Configure the client with `http://127.0.0.1:8787/mcp` and
`Authorization: Bearer <the same token>`. All requests require authentication.
The listener binds only to loopback, validates Host/Origin, and supports
independent MCP sessions, SSE responses, and session termination via DELETE.
It accepts up to 16 sessions; idle sessions expire after 30 minutes. Each
session starts its own app-server lazily. Operations are serialized across
sessions to keep refresh and uncertain-write handling deterministic.

This is a local, single-account bridge. A cloud-only harness needs a separately
secured route to the local endpoint. Hosted multi-user OAuth, legacy HTTP+SSE
transport, and automatic public deployment are not included.

## Implementation

Adapted from Wile's Pi connector bridge (see [NOTICE](NOTICE)):

1. Spawn `codex app-server --listen stdio://`; initialize its experimental API.
2. Read effective config and disable user-configured MCP servers in a temporary,
   ephemeral thread. Enable apps; disable model-adjacent features. No `turn/start`.
3. Read `app/installed`, retaining enabled/callable apps and the optional allowlist.
4. Page `mcpServerStatus/list`; retain `codex_apps` tools and join them to installed
   apps using `_meta.connector_id`.
5. Expose MCP definitions and validate calls against each original input schema.
6. Forward directly through `mcpServer/tool/call`, preserving content blocks,
   structured content, errors, and metadata. Responses are not truncated.
7. Close the child process and remove its temporary workspace on shutdown.

The source extension's Pi UI, consent dialog, output truncation, and Pi package
dependencies are replaced by MCP. Original tool schemas remain inspectable;
scalar/array output schemas are omitted from direct MCP definitions because
MCP requires object output schemas. Draft-07, 2019-09, and 2020-12 input schemas
are validated without coercing or stripping arguments.

See the [official Codex app-server reference](https://learn.chatgpt.com/docs/app-server)
and [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).
The Codex interface is version-sensitive; a future CLI change may require an adapter update.

## Development

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js --help
```

## Verification

```sh
npm run check
npm test
npm audit
npm run test:package
```

Tests are live integration scenarios using the real MCP SDK client, bridge
process, Codex app-server, and current login. They read profiles and exercise
denial paths; they do not perform connector writes or run a model. The checked-in
suite expects GitHub and Instacart connected; Figma's profile is checked when
available. It prints counts/status, not profile contents. See
[integration/SCENARIOS.md](integration/SCENARIOS.md).

`npm run test:package` installs the actual tarball into a temporary directory,
checks its executable and MCP handshake/discovery without a Codex login, and
checks that source files and credentials are excluded. CI runs this on Linux
and macOS; live connector scenarios remain a separate authenticated check.

For publishing setup and release instructions, see [RELEASING.md](RELEASING.md).

The package contains built JavaScript, declarations, README, and license notices.
It has no runtime dependency on the original checkout.

## License

[MIT](LICENSE). Copyright (c) 2026 Wile. Contact: info@wile.ai.
See [NOTICE](NOTICE) for source attribution.
