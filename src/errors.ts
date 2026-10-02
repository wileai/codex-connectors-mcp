/** Only deliberate, public diagnostics may cross the MCP boundary. */
export class PublicError extends Error {}

export function publicErrorMessage(error: unknown): string {
  return error instanceof PublicError ? error.message : "Connector request failed. Check your local Codex setup and retry discovery.";
}

export class CatalogChangedError extends PublicError {
  constructor() {
    super("Connector catalog changed before dispatch; nothing was sent. Rediscover the tool and obtain fresh approval before calling again.");
  }
}
