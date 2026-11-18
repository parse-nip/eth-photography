// Wires the real implementations together. Shared by the Workers and Node entry points.
import { createGateway } from "./gateway.js";
import { createBlockFetcher } from "./ipfs/blocks.js";
import { createDnsLinkResolver } from "./ipfs/dnslink.js";
import { createResolver } from "./resolve.js";

export interface Config {
  BASE_DOMAIN: string;
  /** Comma-separated trustless gateways, tried in order. Safe to use untrusted ones: blocks are hash-verified. */
  IPFS_GATEWAYS: string;
  ETH_RPC_URL?: string;
}

export function buildGateway(env: Config) {
  return createGateway({
    baseDomain: env.BASE_DOMAIN,
    resolveContenthash: createResolver(env.ETH_RPC_URL),
    getBlock: createBlockFetcher({
      gateways: env.IPFS_GATEWAYS.split(",").map((s) => s.trim()).filter(Boolean),
    }),
    resolveDnsLink: createDnsLinkResolver(),
  });
}
