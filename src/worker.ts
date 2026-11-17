// Cloudflare Workers entry point. Config comes from `env` (wrangler.toml vars
// and secrets), not process.env.
import { createGateway } from "./gateway.js";
import { createResolver } from "./resolve.js";

interface Env {
  BASE_DOMAIN: string;
  IPFS_GATEWAY?: string;
  ETH_RPC_URL?: string; // set as a secret: `wrangler secret put ETH_RPC_URL`
}

let handler: ((req: Request) => Promise<Response>) | undefined;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // Build once per isolate so the in-memory cache survives between requests.
    handler ??= createGateway({
      baseDomain: env.BASE_DOMAIN,
      ipfsGateway: env.IPFS_GATEWAY,
      resolveContenthash: createResolver(env.ETH_RPC_URL),
    });
    return handler(request);
  },
};
