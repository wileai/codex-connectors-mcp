# @wileai/codex-connectors-mcp

Use your connected Codex apps, direct web search, and macOS Computer Use from
any harness supporting **MCP stdio** or **Streamable HTTP**. Codex owns
authentication; the harness chooses the model.
No Codex model turn, API key, or Pi dependency is involved.

Website: **https://wileai.github.io/codex-connectors-mcp/**

The npm package is now published under the Wile organization as
`@wileai/codex-connectors-mcp`. Existing users should replace
`codex-connectors-mcp@latest` in their harness configuration with
`@wileai/codex-connectors-mcp@latest`; the executable name remains unchanged.

## Quick start

Requires Node.js 22.19+ and a Codex CLI with `app/installed` and
`mcpServer/tool/call`. Verified with Codex CLI **0.160.0**.

```sh
codex login
```

Add this to your harness's MCP configuration (no clone or build required):

```json
{
  "mcpServers": {
    "codex-connectors": {
      "command": "npx",
      "args": ["-y", "@wileai/codex-connectors-mcp@latest"],
      "env": {
        "CODEX_CONNECTORS_ALLOW": "GitHub"
      }
    }
  }
}
```

`@latest` checks for the current stable version when the server starts; restart
your harness to pick up updates. Pin `@wileai/codex-connectors-mcp@0.1.1` when you need
a fixed version. Prereleases are available through `@next`.

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.codex-connectors]
command = "npx"
args = ["-y", "@wileai/codex-connectors-mcp@latest"]
startup_timeout_sec = 120
tool_timeout_sec = 180

[mcp_servers.codex-connectors.env]
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
read credential files or save connector/web responses to disk. Direct web retrieval
requests a Codex access token from app-server, holds it in memory, and sends it
only to the fixed OpenAI search endpoint. Tokens and opaque backend data never
enter MCP results. Computer Use can save screenshots/session artifacts through
the desktop runtime. This does not guarantee that Codex, connected services,
or the receiving harness retain no data.
Read-only tools can return private data; write denial does not prevent reads.
The app allowlist controls connectors only. Web search and Computer Use have
separate settings; disable them explicitly when sharing only connector access.

## Tools

**Direct mode (default):** every enabled, callable connector tool appears in
`tools/list`, with its complete input schema and provider annotations. Tools
have stable ASCII names capped at 64 characters, e.g.
`github_get_profile_3b5eaf4306c5`. These names work in clients that reject dots.

These connector management tools are available in either mode:

| Tool | Purpose |
| --- | --- |
| `codex_connectors` | List apps; filter tools by `connector` and/or `query`; paginate with `offset`/`limit`; reload with `refresh: true` |
| `codex_connector_schema` | Full original tool definition, plus its exposed name |
| `codex_connector_call` | Call by original or exposed name with an `arguments` object |

**Compact mode:** set `CODEX_CONNECTORS_MODE=compact` to expose these three
connector management tools plus enabled web/computer tools. All eligible
connector tools remain callable through the dispatcher.
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

## Web search

`codex_web_search` is available in both modes by default. It supports up to four
operations each in `search_query`, `open`, `find`, and `click`, with source URLs
and result references. Indexed retrieval can return link IDs that the upstream
click endpoint rejects on some pages; those errors are preserved without retrying
or broadening access. Reuse references within the same MCP connection; closing
it resets their scope. Connector catalog refresh does not reset web references.

```text
codex_web_search({"search_query":[{"q":"OpenAI Codex documentation"}],"allowed_domains":["developers.openai.com"]})
codex_web_search({"open":[{"ref_id":"<reference returned by search>"}]})
```

`CODEX_CONNECTORS_WEB_SEARCH` sets maximum access: `disabled`, `cached` (default),
`indexed`, or `live`. A tool's `mode` argument can narrow access but cannot broaden
it. These map to the upstream `external_web_access` settings `false`, `"indexed"`,
and `true`. Domain filters apply to hosted retrieval, not local networking or
connector access. Web content is untrusted source material.

Retrieval requires a ChatGPT Codex login. It uses Codex's standalone search
endpoint with no `thread/start` or `turn/start`. The endpoint is version-sensitive
and may be unavailable for an account; failures never fall back to inference or
broader access. `CODEX_CONNECTORS_WEB_SEARCH_MODEL` selects its routing field
(default `gpt-5.4`), not a model turn. Requests time out after 60 seconds; responses
are capped at 2 MiB without truncating or saving a full response.

## Computer Use

On macOS, the bridge automatically exposes `codex_computer_js` and
`codex_computer_js_reset` when ChatGPT's bundled Computer Use runtime is installed.
Set `CODEX_CONNECTORS_COMPUTER_APP` for a non-default installation, or
`CODEX_CONNECTORS_COMPUTER=disabled` to disable it. `codex_computer_status` is always
available and explains missing runtime/platform support without starting it.
Missing Computer Use does not prevent connector or web-search startup.

```text
codex_computer_js({"code":"var sky = (await import('@oai/sky')).sky; nodeRepl.write(JSON.stringify(await sky.list_apps()));","title":"List available apps"})
```

JavaScript state persists per MCP connection. Follow the tool's Sky instructions
and runtime guidance; read fresh app state after each action. Text and images
are forwarded through MCP. `js_reset` clears JavaScript state, not app approvals.

Native app access requests are forwarded as MCP form elicitation, offering
**this request**, **this session**, **forever**, or **No**. Session/forever choices
are offered only when the native policy allows them. Saved grants live in
`$CODEX_HOME/codex-connectors-mcp/computer-use-approvals.json` (default under
`~/.codex`), written atomically with owner-only permissions. Clients without
elicitation decline new app access; permitted saved grants can be reused.
`codex_computer_forget` closes this connection's runtime and clears its session
and saved grants, subject to `CODEX_CONNECTORS_WRITES`.

Computer Use JavaScript runs with the current user's privileges, including file,
process, and network access; native app prompts do not sandbox JavaScript.
`CODEX_CONNECTORS_WRITES` governs each JavaScript/reset call and forgetting grants:
`deny` blocks calls, `ask` requires approval of the exact tool and arguments
(including code and title), and `allow` delegates authorization to the harness.
Native app access still requires its separate approval. The receiving harness
must authorize UI actions. An app grant does
not authorize sending messages, submitting forms, deleting data, or changing
settings. Native restrictions remain enforced. Declined access must not be
retried through another app, JavaScript reset, or alternative automation.

Cancellation, timeout, or runtime disconnection after a Computer Use call is
dispatched can leave an unknown outcome. Further JavaScript/reset calls are
blocked across this process's HTTP sessions. Inspect the app before restarting;
reset, forgetting grants, and connector refresh cannot clear that guard.

## Writes

| `CODEX_CONNECTORS_WRITES` | Behavior |
| --- | --- |
| `ask` (default) | Request approval through MCP form elicitation, displaying the exact tool and arguments. Clients without elicitation cannot write. |
| `allow` | Let the receiving harness handle authorization; the bridge adds no write confirmation. |
| `deny` | Reject connector tools not marked read-only, all destructive connector tools, and Computer Use JavaScript/reset/forget calls. |

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
| `CODEX_CONNECTORS_WEB_SEARCH` | `cached` | Maximum retrieval access: `disabled`, `cached`, `indexed`, `live` |
| `CODEX_CONNECTORS_WEB_SEARCH_MODEL` | `gpt-5.4` | Standalone retrieval routing field; no inference |
| `CODEX_CONNECTORS_COMPUTER` | `auto` | Automatically expose installed macOS runtime; `disabled` opts out |
| `CODEX_CONNECTORS_COMPUTER_APP` | `/Applications/ChatGPT.app` | Desktop runtime installation path |
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
npx -y @wileai/codex-connectors-mcp@latest --transport http --port 8787
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
   Web retrieval uses a separate auth-only app-server; Computer Use uses the local
   desktop runtime instead of the connector thread.
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
npm run test:offline
npm test
npm audit
npm run test:package
```

`npm run test:offline` checks synthetic web authentication/HTTP, mode limits,
privacy, cancellation, native approval policy, and MCP tool routing without a
login or network. CI runs these checks on Linux and macOS.

`npm test` additionally runs live integration scenarios using the real MCP SDK client, bridge
process, Codex app-server, and current login. They read profiles and exercise
denial paths, real retrieval in all three modes, and (when installed) a harmless
Calculator accessibility/screenshot read, persistent JavaScript, and reset.
They do not perform connector writes, clicks, typing, or run a model. The checked-in
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
