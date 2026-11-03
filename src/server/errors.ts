/** A request the API refuses. Rendered as `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "bad_request", message, details);

export const notFound = (message: string) => new ApiError(404, "not_found", message);

/** The request is well formed but the node's current state doesn't allow it. */
export const refused = (message: string, details?: unknown) =>
  new ApiError(409, "refused", message, details);

/** `config.yaml` or `stages.yaml` is invalid. Carries every problem, not just the first. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid AOP config:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}
