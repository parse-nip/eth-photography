// Wires the real implementations together. Shared by the Workers and Node entry points.
import { createGateway } from "./gateway.js";
import { createBlockFetcher, type PersistentCache } from "./ipfs/blocks.js";
import { createDnsLinkResolver } from "./ipfs/dnslink.js";
import { createIpnsResolver } from "./ipfs/ipns.js";
import { createResolver } from "./resolve.js";

export interface Config {
  BASE_DOMAIN: string;
  /** Comma-separated trustless gateways, tried in order. Safe to use untrusted ones: blocks are hash-verified. */
  IPFS_GATEWAYS: string;
  /** Comma-separated ".../ipns" endpoints that serve signed IPNS records. */
  IPNS_SOURCES?: string;
  ETH_RPC_URL?: string;
}

const DEFAULT_IPNS_SOURCES = "https://delegated-ipfs.dev/routing/v1/ipns,https://ipfs.io/ipns,https://ipfs.filebase.io/ipns";

// `caches.default` exists on Cloudflare Workers only.
const edgeCache = (): PersistentCache | undefined =>
  typeof caches !== "undefined" ? (caches as unknown as { default: PersistentCache }).default : undefined;

export function buildGateway(env: Config) {
  return createGateway({
    baseDomain: env.BASE_DOMAIN,
    resolveContenthash: createResolver(env.ETH_RPC_URL),
    getBlock: createBlockFetcher({
      gateways: env.IPFS_GATEWAYS.split(",").map((s) => s.trim()).filter(Boolean),
      persistentCache: edgeCache(),
    }),
    resolveDnsLink: createDnsLinkResolver(),
    resolveIpns: createIpnsResolver({
      sources: (env.IPNS_SOURCES ?? DEFAULT_IPNS_SOURCES).split(",").map((x) => x.trim()).filter(Boolean),
    }),
  });
}
