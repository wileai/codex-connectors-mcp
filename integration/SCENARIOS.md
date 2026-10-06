# Live scenarios

- Direct stdio: complete catalog; unique portable names; original schema lookup;
  real GitHub profile through direct and dispatcher calls; Figma draft-2020 input;
  invalid arguments; unknown tools; write denial; refresh notification and stable
  names; old/new app-server process cleanup.
- Compact stdio: connector management and computer status tools; allowlisted discovery; pagination; real profile;
  clients without elicitation cannot write; excluded tools cannot be called.
- Approval: real MCP elicitation reaches the client; decline blocks the operation.
- Empty allowlist: no connector metadata/tools exposed; excluded calls rejected.
  Web/computer settings remain independent of the connector allowlist.
- HTTP: missing credentials and foreign Origin rejected; unknown sessions rejected;
  independent authenticated sessions; real reads; DELETE removes one session without
  affecting the other; all app-server processes exit on session cleanup.
- Lifecycle: missing executable; cancellation before dispatch; SIGKILL and recovery
  with a real profile read; closed-service rejection; timeout after dispatch of a
  harmless read reports an unknown outcome.

- Reconnection authorization: kill the real app-server after discovery; the stale
  call is rejected before dispatch, tools/list_changed arrives, and a fresh read succeeds.
- Diagnostic privacy: missing executable paths stay out of MCP errors; a real
  Codex invalid-config diagnostic containing a sentinel is suppressed; rejected
  RPC request text is not forwarded.

These scenarios require the current Codex login and network access. They do not
simulate a provider or exercise successful remote mutations. No profile payloads
or account-specific schemas are saved in the repository.

- Package distribution (no login): install the real npm tarball outside the
  checkout with production dependencies only; launch the installed executable;
  verify help, MCP initialization/version and compact discovery, and package
  file allowlist. Run with `npm run test:package`.

- Offline web protocol: auth-only RPC (no thread/turn), fixed endpoint, per-session
  result scope, bounded output, private errors, cancellation during auth/fetch,
  no anonymous requests, no broader-mode fallback, dispatcher and schema access.
- Offline Computer Use: once/session/forever grants, owner-only atomic storage,
  native persistence restrictions, revocation, denial without elicitation,
  paused approval deadlines, cancellation/timeout/crash cleanup, image forwarding,
  and process-wide unknown-outcome blocking across MCP sessions. Synthetic runtime
  discovery runs on macOS; protocol/permission tests run on both platforms.
- Live web: cached/indexed/live query, reference open/find/click over real MCP stdio.
- Live desktop (when available): automatic discovery, persistent JavaScript,
  Calculator accessibility/screenshot read with one-request app approval, reset.
  No clicks, typing, settings changes, messages, or permanent app grants.

Port source: pi-codex-connectors v0.3.1, 2048f50; feature commits 746c55e,
6b6be6f, and 5bb14a0. Pi's global consent UI is replaced by MCP configuration;
app-specific grant persistence is retained via MCP elicitation.

- Live HTTP builtins: two independent retrieval reference scopes, isolated desktop
  JavaScript state, and DELETE of one session without interrupting the other.

Upstream retrieval caveat: indexed mode can return rendered link IDs that fail
`click` on large API documentation pages. This was reproduced through direct
retrieval before `find`, independently of MCP routing. Compact Codex documentation
links work in all modes. The bridge preserves upstream output and never broadens
access or retries automatically.
