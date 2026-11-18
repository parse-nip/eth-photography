// Cloudflare Workers entry point. Config comes from `env` (wrangler.toml vars
// and secrets), not process.env.
import { buildGateway, type Config } from "./setup.js";

let handler: ((req: Request) => Promise<Response>) | undefined;

export default {
  fetch(request: Request, env: Config): Promise<Response> {
    // Build once per isolate so the in-memory caches survive between requests.
    handler ??= buildGateway(env);
    return handler(request);
  },
};
