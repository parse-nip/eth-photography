import { decodeContenthash, UnsupportedContenthashError } from "./contenthash.js";
import { CID } from "multiformats/cid";
import { BlockUnavailableError, type GetBlock } from "./ipfs/blocks.js";
import type { DnsLinkResolver } from "./ipfs/dnslink.js";
import { IpnsError, type IpnsResolver } from "./ipfs/ipns.js";
import { NotFoundError, openFile, resolvePath, UnsupportedUnixFsError, type Resolved } from "./ipfs/unixfs.js";
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
  /** IPNS key name (k51...) -> verified record. */
  resolveIpns: IpnsResolver;
}

// Where an ENS name's site lives: a root CID, plus a sub-directory if an IPNS
// record pointed at one ("/ipfs/<cid>/dist").
interface Site { root: string; prefix: string[] }

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

// Parse an HTTP Range header: "bytes=0-99", "bytes=500-" (to the end), "bytes=-100" (last 100).
// Returns inclusive byte positions, "unsatisfiable" if it starts past the end,
// or undefined for anything we ignore (no header, multiple ranges, unknown size),
// in which case the caller just serves the whole file, which is always allowed.
function parseRange(
  header: string | null,
  size: bigint | undefined,
): { start: number; end: number } | "unsatisfiable" | undefined {
  if (!header || size === undefined) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  const total = Number(size);
  let start: number, end: number;
  if (m[1] === "") {                       // suffix form: the last N bytes
    start = Math.max(total - Number(m[2]), 0);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (start >= total || start > end) return "unsatisfiable";
  return { start, end };
}

export function createGateway(opts: GatewayOptions) {
  const baseDomain = opts.baseDomain.toLowerCase();
  // name -> site, or null = "looked it up, nothing there" (cached shorter so
  // newly-set records show up soon).
  const cache = new TtlCache<Site | null>();

  // ENS name -> the site it points to.
  async function lookupSite(name: string): Promise<Site> {
    const cached = cache.get(name);
    if (cached === null) throw new NoContentError();
    if (cached !== undefined) return cached;

    const hex = await opts.resolveContenthash(name);
    let site: Site | null = null;
    let ttlMs = 5 * 60_000;
    if (hex) {
      const content = decodeContenthash(hex);
      if (content.protocol === "ipfs") {
        site = { root: content.id, prefix: [] };
      } else if (content.id.includes(".")) {
        const root = await opts.resolveDnsLink(content.id); // IPNS-by-domain => DNSLink
        site = root ? { root, prefix: [] } : null;
      } else {
        // A real IPNS key: fetch + verify the signed record. These change without
        // any ENS transaction, so the cache lifetime comes from the record's TTL.
        const rec = await opts.resolveIpns(content.id);
        site = { root: rec.cid, prefix: rec.path };
        ttlMs = rec.ttlMs;
      }
    }
    cache.set(name, site, site ? ttlMs : 60_000);
    if (!site) throw new NoContentError();
    return site;
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
      const site = await lookupSite(ensName);
      const root = site.root;
      let rootCid = CID.parse(root);
      if (site.prefix.length > 0) {
        const dir = await resolvePath(opts.getBlock, rootCid, site.prefix);
        if (dir.kind !== "directory") throw new NotFoundError("IPNS record points at a file, not a site");
        rootCid = dir.cid;
      }

      // Does the browser want a web page? (Navigations send "Accept: text/html".)
      const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
      const lastSegment = segments.at(-1) ?? "";
      const looksLikeFile = lastSegment.includes("."); // "/app.js", "/logo.png" vs "/swap/eth"

      let target: Resolved;
      let filename = lastSegment || "index.html";
      let status = 200;

      try {
        target = await resolvePath(opts.getBlock, rootCid, segments);
        if (target.kind === "directory") {
          // "/photos" must become "/photos/" so relative links inside the page
          // (<img src="a.jpg">) resolve against the folder, not its parent.
          if (!url.pathname.endsWith("/")) {
            return new Response(null, { status: 301, headers: { location: `${url.pathname}/${url.search}` } });
          }
          target = await resolvePath(opts.getBlock, target.cid, ["index.html"]);
          filename = "index.html";
        }
      } catch (err) {
        if (!(err instanceof NotFoundError) || !wantsHtml || segments.length === 0) throw err;
        // A page that doesn't exist. Two conventions, in order:
        //  1. The site ships its own 404.html (static site generators): serve it with a 404.
        //  2. Otherwise it's probably a single-page app whose JavaScript handles URLs like
        //     "/swap/eth" itself: serve the root index.html with 200 and let the app route.
        //     Skipped for things that look like files, so a missing "/app.js" is a real 404.
        try {
          target = await resolvePath(opts.getBlock, rootCid, ["404.html"]);
          filename = "404.html";
          status = 404;
        } catch (e404) {
          if (!(e404 instanceof NotFoundError) || looksLikeFile) throw err;
          target = await resolvePath(opts.getBlock, rootCid, ["index.html"]);
          filename = "index.html";
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
        "accept-ranges": "bytes",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "x-ens-name": ensName,
        "x-content-path": `/ipfs/${root}${url.pathname}`,
        // The file for a given CID never changes, but which CID the ENS name
        // points to can, so keep browser/CDN caching short.
        "cache-control": "public, max-age=300",
      });
      if (status === 200 && request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers });
      }

      // Range request ("give me bytes 1000000-1999999"): how browsers seek in video/audio
      // and resume downloads. Needs the file size; HEAD and If-Range get the full file.
      let range: { start: number; end: number } | undefined;
      const wanted = request.method === "GET" && !request.headers.has("if-range") && status === 200
        ? parseRange(request.headers.get("range"), target.size)
        : undefined;
      if (wanted === "unsatisfiable") {
        headers.set("content-range", `bytes */${target.size}`);
        return new Response(null, { status: 416, headers });
      }
      if (wanted) {
        range = { start: wanted.start, end: wanted.end + 1 }; // HTTP ranges are inclusive; ours is exclusive
        status = 206;
        headers.set("content-range", `bytes ${wanted.start}-${wanted.end}/${target.size}`);
        headers.set("content-length", String(wanted.end - wanted.start + 1));
      }

      const body = request.method === "HEAD" ? null : await openFile(opts.getBlock, target.cid, range);
      return new Response(body, { status, headers });
    } catch (err) {
      if (err instanceof NoContentError) return text(404, `${ensName} has no website set`);
      if (err instanceof NotFoundError) return text(404, "Not found");
      if (err instanceof UnsupportedContenthashError) {
        return text(501, `${ensName} uses a content type this gateway doesn't support (${err.message})`);
      }
      if (err instanceof IpnsError) {
        console.error("ipns failed", ensName, err.message);
        return text(502, "Could not find a current, valid IPNS record for this name");
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
