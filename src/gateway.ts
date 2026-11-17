import { decodeContenthash, UnsupportedContenthashError, type Content } from "./contenthash.js";

export interface GatewayOptions {
  /** Domain we serve under, e.g. "eth.photography". alice.<baseDomain> => alice.eth */
  baseDomain: string;
  /** name -> raw contenthash hex, or null if the name has none. */
  resolveContenthash: (name: string) => Promise<`0x${string}` | null>;
  /** Trustless HTTP gateway we fetch content from. */
  ipfsGateway?: string;
  /** Injectable so tests don't touch the network. */
  fetch?: typeof fetch;
}

// A tiny TTL cache so repeat visitors don't each trigger blockchain lookups.
// Lives in memory, per server/isolate: simple, and fine to start with.
class TtlCache<V> {
  private map = new Map<string, { value: V; expires: number }>();
  constructor(private max = 1000) {}
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  set(key: string, value: V, ttlMs: number) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!); // evict oldest
    this.map.set(key, { value, expires: Date.now() + ttlMs });
  }
}

// DNS-safe labels only (a-z, 0-9, hyphen). Rejecting everything else early means
// weird input never reaches the ENS library or the upstream URL.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const text = (status: number, body: string) =>
  new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });

export function createGateway(opts: GatewayOptions) {
  const baseDomain = opts.baseDomain.toLowerCase();
  const ipfsGateway = (opts.ipfsGateway ?? "https://ipfs.io").replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  // null = "looked it up, nothing there" (cached shorter so new records show up soon)
  const cache = new TtlCache<Content | null>();

  async function lookup(name: string): Promise<Content | null> {
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const hex = await opts.resolveContenthash(name);
    const content = hex ? decodeContenthash(hex) : null;
    cache.set(name, content, content ? 5 * 60_000 : 60_000);
    return content;
  }

  return async function handle(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "Method not allowed");
    }

    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();

    // Apex domain: a landing page.
    if (host === baseDomain || host === `www.${baseDomain}`) {
      return text(200, `eth.photography: visit <name>.${baseDomain} to view <name>.eth`);
    }
    if (!host.endsWith(`.${baseDomain}`)) return text(404, "Unknown host");

    // "alice.eth.photography" -> sub = "alice" -> ENS name "alice.eth"
    // "blog.alice.eth.photography" -> "blog.alice.eth" (an ENS subname)
    const sub = host.slice(0, -(baseDomain.length + 1));
    const labels = sub.split(".");
    if (!labels.every((l) => LABEL.test(l))) return text(400, "Invalid name");
    const ensName = `${sub}.eth`;

    let content: Content | null;
    try {
      content = await lookup(ensName);
    } catch (err) {
      if (err instanceof UnsupportedContenthashError) {
        return text(501, `${ensName} uses a content type this gateway doesn't support (${err.message})`);
      }
      console.error("resolution failed", ensName, err);
      return text(502, "Could not resolve ENS name");
    }
    if (!content) return text(404, `${ensName} has no website set`);

    // Build the upstream URL. url.pathname is already normalised by URL (no "..").
    const upstream = `${ipfsGateway}/${content.protocol}/${content.id}${url.pathname}${url.search}`;
    let res: Response;
    try {
      res = await doFetch(upstream, {
        method: request.method,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: request.headers.get("accept") ?? "*/*" }, // forward nothing else (no cookies!)
      });
    } catch (err) {
      console.error("upstream failed", upstream, err);
      return text(504, "Content gateway timed out or failed");
    }

    // Public gateways answer 429/403 when they refuse to serve HTML to proxies.
    // That's our upstream's failure, not the visitor's, so report it as 502.
    if (res.status === 429 || res.status === 403 || res.status >= 500) {
      console.error("upstream refused", upstream, res.status);
      return text(502, "Content gateway refused the request (check IPFS_GATEWAY config)");
    }

    // Allowlist headers instead of copying everything. In particular this drops
    // Set-Cookie, so hosted content can't plant cookies, and we replace caching
    // and security headers with our own.
    const headers = new Headers();
    for (const h of ["content-type", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = res.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-ens-name", ensName);
    headers.set("x-content-path", `/${content.protocol}/${content.id}`);
    // The ENS record can change, so keep caching short, and never cache errors.
    headers.set("cache-control", res.ok ? "public, max-age=300" : "no-store");

    return new Response(request.method === "HEAD" ? null : res.body, { status: res.status, headers });
  };
}
