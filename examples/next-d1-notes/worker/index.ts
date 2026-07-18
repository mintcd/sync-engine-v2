import handler from "vinext/server/app-router-entry";

interface Env {
  readonly DB?: unknown;
  readonly [key: string]: unknown;
}

declare global {
  // Vinext route modules read the Cloudflare env from the active worker request.
  var __env: Env | undefined;
  var __origin: string | undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    globalThis.__origin = url.origin;
    globalThis.__env = env;

    return handler.fetch(request);
  },
};
