# eth.photography

ENS → Web2 gateway. `alice.eth.photography` serves whatever `alice.eth` points to
via its ENS **contenthash** (IPFS / IPNS).

```
browser → *.eth.photography → Worker
   1. ENS (Ethereum RPC)        name.eth → contenthash
   2. decode                    → root CID  (or DNSLink domain → CID via DoH)
   3. trustless gateways        fetch raw blocks, VERIFY sha256 == CID
   4. UnixFS walker             walk directories to the requested path
   5. stream file bytes → browser
```

Blocks are fetched from public gateways but never trusted: each one is hashed
locally and must match its CID, so a lying gateway is just skipped.

| File | Job |
|---|---|
| `src/resolve.ts` | name → raw contenthash (ENS registry + resolver, ENSIP-10 aware) |
| `src/contenthash.ts` | raw bytes → `{protocol, id}` (EIP-1577) |
| `src/ipfs/blocks.ts` | fetch + hash-verify blocks, gateway failover |
| `src/ipfs/unixfs.ts` | directory walking, multi-chunk file streaming |
| `src/ipfs/dnslink.ts` | `_dnslink.<domain>` TXT lookup over DoH |
| `src/gateway.ts` | request handling: host→name, path, cache, headers |
| `src/mime.ts` | extension → Content-Type |
| `src/setup.ts` / `src/worker.ts` / `src/node.ts` | wiring and entry points |

## Develop
```bash
npm install
npm test          # unit tests, no network
npm run dev       # http://vitalik.localhost:8787
```
Env: `ETH_RPC_URL` (Ethereum RPC), `IPFS_GATEWAYS` (comma-separated trustless gateways), `BASE_DOMAIN`.

## Deploy
See the setup checklist: Cloudflare zone, wildcard DNS, `ETH_RPC_URL` secret, dedicated IPFS gateway, `npm run deploy`.

## Features
- Range requests (video seeking, resumable downloads): skips chunks outside the range.
- SPA fallback: extensionless unknown paths serve `index.html` to browsers; a site's own `404.html` wins if present.
- IPNS key names (ed25519): signed records fetched from several sources, verified locally
  (signature, expiry, highest sequence). A forged or expired record is never served.
- DNSLink for ENS names that store a domain.

## Known limits
- IPFS only. Swarm and Arweave return 501. RSA IPNS keys return 501.
- IPNS needs a source that has the record. Public routers often don't (see `IPNS_SOURCES`);
  the ENS team's eth.limo uses its own node. IPNS can't prove a record is the *latest*,
  only that it is genuine and unexpired (a source could serve an older valid one).
- Sharded (HAMT) directories return 501; very large folders are affected.
- Nested names (`app.ens.eth.photography`) need a certificate beyond the free `*.eth.photography`.
- Third-party apps that allowlist their own domain (API keys, wallet-connect IDs) may refuse ours; not fixable here.
- No directory listings. ASCII names only (no emoji/unicode ENS names yet).
- DNSLink answers come from Cloudflare DoH and can't be hash-verified.
