# Live scenarios

- Direct stdio: complete catalog; unique portable names; original schema lookup;
  real GitHub profile through direct and dispatcher calls; Figma draft-2020 input;
  invalid arguments; unknown tools; write denial; refresh notification and stable
  names; old/new app-server process cleanup.
- Compact stdio: three tools; allowlisted discovery; pagination; real profile;
  clients without elicitation cannot write; excluded tools cannot be called.
- Approval: real MCP elicitation reaches the client; decline blocks the operation.
- Empty allowlist: no connector metadata/tools exposed; excluded calls rejected.
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
