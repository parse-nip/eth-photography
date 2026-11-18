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

## Known limits
- IPFS only. IPNS key names (`k51...`), Swarm and Arweave return 501. DNSLink works for `/ipfs/` targets.
- Sharded (HAMT) directories return 501; very large folders are affected.
- No Range requests, no directory listings, no SPA `404.html` fallback.
- One HTTP request per block: Cloudflare's free plan allows 50 subrequests per request, so
  files over ~10 MB may fail there. The fix is fetching a CAR stream (one request per file).
- ASCII names only (no emoji/unicode ENS names yet).
- DNSLink answers come from Cloudflare DoH and can't be hash-verified.
