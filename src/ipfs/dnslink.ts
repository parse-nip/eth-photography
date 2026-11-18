import { CID } from "multiformats/cid";
import { UnsupportedContenthashError } from "../contenthash.js";

// DNSLink: a domain publishes "where my site lives" as a DNS TXT record on
//   _dnslink.<domain>   →   "dnslink=/ipfs/<cid>"
// Some ENS names store a *domain* (like app.uniswap.org) in their contenthash
// instead of a CID, so we look that TXT record up ourselves.
//
// We use DNS-over-HTTPS because Workers can't send raw DNS packets. Trust note:
// unlike block data, a DNS answer can't be verified against a hash. We trust
// Cloudflare's resolver (and DNSSEC, where the domain has it) for this one step.

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type DnsLinkResolver = (domain: string) => Promise<string | null>;

export function createDnsLinkResolver(doFetch: typeof fetch = fetch): DnsLinkResolver {
  return async (domain) => {
    const d = domain.toLowerCase();
    if (!DOMAIN.test(d)) return null; // never put unvalidated input in a URL

    const res = await doFetch(
      `https://cloudflare-dns.com/dns-query?name=_dnslink.${d}&type=TXT`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`DNS lookup failed: HTTP ${res.status}`);
    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };

    for (const answer of body.Answer ?? []) {
      if (answer.type !== 16) continue; // 16 = TXT (skips CNAME hops in the chain)
      // TXT data arrives quoted, possibly split: "dnslink=/ip" "fs/bafy..."
      const txt = answer.data.replace(/"\s*"/g, "").replace(/^"|"$/g, "");
      const m = /^dnslink=\/(ipfs|ipns)\/([^/]+)/.exec(txt);
      if (!m) continue;
      if (m[1] === "ipns") throw new UnsupportedContenthashError("DNSLink pointing at IPNS is not supported");
      try { return CID.parse(m[2]).toString(); } catch { return null; }
    }
    return null;
  };
}
