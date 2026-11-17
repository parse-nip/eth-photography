# eth.photography

ENS → Web2 gateway. `alice.eth.photography` serves whatever `alice.eth` points to
via its ENS **contenthash** (IPFS / IPNS).

```
browser → *.eth.photography → Worker → ENS (Ethereum RPC) → contenthash
                                     → decode → IPFS gateway → response
```

| File | Job |
|---|---|
| `src/resolve.ts` | name → raw contenthash (ENS registry + resolver, ENSIP-10 aware) |
| `src/contenthash.ts` | raw bytes → `{protocol, id}` (EIP-1577) |
| `src/gateway.ts` | request handling: host→name, cache, proxy, header hygiene |
| `src/worker.ts` / `src/node.ts` | Cloudflare Workers / local dev entry points |

## Develop
```bash
npm install
npm test          # unit tests, no network
npm run dev       # http://vitalik.localhost:8787
```
Env: `ETH_RPC_URL` (Ethereum RPC), `IPFS_GATEWAY` (upstream), `BASE_DOMAIN`.

## Deploy
See the setup checklist: Cloudflare zone, wildcard DNS, `ETH_RPC_URL` secret, dedicated IPFS gateway, `npm run deploy`.

## Known limits (v1)
- Public IPFS gateways (ipfs.io, dweb.link, w3s.link, Pinata public) refuse to serve HTML to proxies. Use a dedicated gateway.
- IPFS/IPNS only. Swarm (`0xe4`) and Arweave return 501.
- ASCII names only (no emoji/unicode ENS names yet).
- Gateway trusts its upstream for content integrity; no local hash verification.
