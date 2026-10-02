# npm releases

## One-time setup

1. Add a repository Actions secret named `NPM_TOKEN` in
   [GitHub settings](https://github.com/wileai/codex-connectors-mcp/settings/secrets/actions/new).
   Use an npm granular token with direct read/write publishing permission and
   bypass 2FA enabled. It must allow creating `codex-connectors-mcp` for the first
   publish, then publishing subsequent versions. A stage-only token cannot publish
   automatically. Never paste the token into an issue, chat, or committed file.
2. Alternatively, run `gh secret set NPM_TOKEN --repo wileai/codex-connectors-mcp`
   locally and paste it at the hidden prompt. No token is needed by package users.
3. Merge the publishing workflow before creating the first release.

After the initial publish, you can replace the token with
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): configure
GitHub owner `wileai`, repository `codex-connectors-mcp`, workflow `publish.yml`,
no environment, and allow direct `npm publish`. Then remove the `NPM_TOKEN`
repository secret. The workflow already grants OIDC permission and runs Node 24
with an OIDC-capable npm version. Trusted publishing avoids token expiration and
rotation; token-based publishing requires renewing the secret before expiration.

## Publish a version

1. Run `npm ci --ignore-scripts`, `npm run check`, `npm run test:package`, and
   the authenticated live scenarios (`npm test`) locally before releasing.
   CI verifies packaging without storing a maintainer's Codex credentials.
2. Create and publish a [GitHub Release](https://github.com/wileai/codex-connectors-mcp/releases/new)
   from the intended commit, with a new tag such as `v0.1.0` or `v0.2.0`.
   Publishing a release triggers the workflow; pushing a tag or saving a draft
   alone does not publish npm packages.
3. The workflow sets `package.json` and the lockfile version from the tag in its
   temporary checkout, verifies the package, and publishes it with provenance.
   No version bump commit or force push is needed. The source checkout can keep
   its development version; published packages and MCP report the release version.
4. Confirm the [workflow](https://github.com/wileai/codex-connectors-mcp/actions/workflows/publish.yml)
   succeeded, then run `npm view codex-connectors-mcp version` and
   `npx -y codex-connectors-mcp@latest --help`.

Stable tags publish to `latest`. For a prerelease, use a tag such as
`v0.2.0-beta.1` **and** check GitHub's prerelease box; it publishes to `next`.
The workflow rejects mismatched tags/status. To promote a prerelease, publish a
new stable version, rather than editing the existing release. Publish stable
releases in increasing version order: each one updates `latest`.

npm versions are immutable. If publishing failed before upload, rerun the failed
workflow after fixing the cause. If the version already exists, inspect npm
before retrying; publish a new version for changes. Never move a published tag.
