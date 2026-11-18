import { decodeContenthash, UnsupportedContenthashError } from "./contenthash.js";
import { CID } from "multiformats/cid";
import { BlockUnavailableError, type GetBlock } from "./ipfs/blocks.js";
import type { DnsLinkResolver } from "./ipfs/dnslink.js";
import { NotFoundError, resolvePath, streamFile, UnsupportedUnixFsError } from "./ipfs/unixfs.js";
import { contentTypeFor } from "./mime.js";

export interface GatewayOptions {
  /** Domain we serve under, e.g. "eth.photography". alice.<baseDomain> => alice.eth */
  baseDomain: string;
  /** name -> raw contenthash hex, or null if the name has none. */
  resolveContenthash: (name: string) => Promise<`0x${string}` | null>;
  /** Fetches + verifies one IPFS block by CID. */
  getBlock: GetBlock;
  /** domain -> CID string from its DNSLink TXT record (for ENS names that store a domain). */
  resolveDnsLink: DnsLinkResolver;
}

class NoContentError extends Error {}

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
// weird input never reaches the ENS library.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_FILE_BYTES = 100n * 1024n * 1024n;

const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...extra },
  });

export function createGateway(opts: GatewayOptions) {
  const baseDomain = opts.baseDomain.toLowerCase();
  // name -> root CID (string), or null = "looked it up, nothing there" (cached shorter
  // so newly-set records show up soon).
  const cache = new TtlCache<string | null>();

  // ENS name -> the root CID of its website.
  async function lookupRoot(name: string): Promise<string> {
    const cached = cache.get(name);
    if (cached === null) throw new NoContentError();
    if (cached !== undefined) return cached;

    const hex = await opts.resolveContenthash(name);
    let root: string | null = null;
    if (hex) {
      const content = decodeContenthash(hex);
      if (content.protocol === "ipfs") {
        root = content.id;
      } else if (content.id.includes(".")) {
        root = await opts.resolveDnsLink(content.id); // IPNS-by-domain => DNSLink
      } else {
        throw new UnsupportedContenthashError("IPNS key names are not supported yet");
      }
    }
    cache.set(name, root, root ? 5 * 60_000 : 60_000);
    if (!root) throw new NoContentError();
    return root;
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
    if (!sub.split(".").every((l) => LABEL.test(l))) return text(400, "Invalid name");
    const ensName = `${sub}.eth`;

    // URL path -> list of decoded segments: "/img/my%20pic.jpg" -> ["img", "my pic.jpg"]
    let segments: string[];
    try {
      segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return text(400, "Invalid path encoding");
    }

    try {
      const root = await lookupRoot(ensName);
      const rootCid = CID.parse(root);

      let target = await resolvePath(opts.getBlock, rootCid, segments);
      let filename = segments.at(-1) ?? "index.html";

      if (target.kind === "directory") {
        // "/photos" must become "/photos/" so relative links inside the page
        // (<img src="a.jpg">) resolve against the folder, not its parent.
        if (!url.pathname.endsWith("/")) {
          return new Response(null, { status: 301, headers: { location: `${url.pathname}/${url.search}` } });
        }
        try {
          target = await resolvePath(opts.getBlock, target.cid, ["index.html"]);
          filename = "index.html";
        } catch (err) {
          if (err instanceof NotFoundError) return text(404, "No index.html in this directory");
          throw err;
        }
      }
      if (target.kind !== "file") return text(404, "Not a file");
      if (target.size !== undefined && target.size > MAX_FILE_BYTES) return text(413, "File too large for this gateway");

      // The file's CID is a hash of its content, which makes it a perfect ETag:
      // if the browser already has this CID, say so and skip the transfer.
      const etag = `"${target.cid.toString()}"`;
      const headers = new Headers({
        "content-type": contentTypeFor(filename),
        etag,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-ens-name": ensName,
        "x-content-path": `/ipfs/${root}${url.pathname}`,
        // The file for a given CID never changes, but which CID the ENS name
        // points to can, so keep browser/CDN caching short.
        "cache-control": "public, max-age=300",
      });
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

      const body = request.method === "HEAD" ? null : streamFile(opts.getBlock, target.cid);
      return new Response(body, { status: 200, headers });
    } catch (err) {
      if (err instanceof NoContentError) return text(404, `${ensName} has no website set`);
      if (err instanceof NotFoundError) return text(404, "Not found");
      if (err instanceof UnsupportedContenthashError) {
        return text(501, `${ensName} uses a content type this gateway doesn't support (${err.message})`);
      }
      if (err instanceof UnsupportedUnixFsError) return text(501, `Unsupported content: ${err.message}`);
      if (err instanceof BlockUnavailableError) {
        console.error("block unavailable", ensName, err.message);
        return text(502, "Content is not reachable on the IPFS network right now");
      }
      console.error("request failed", ensName, err);
      return text(502, "Could not resolve ENS name");
    }
  };
}
