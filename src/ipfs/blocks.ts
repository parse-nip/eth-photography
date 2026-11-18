import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

// A "block" is the unit of IPFS data: some bytes plus a CID that names them.
// A CID is (mostly) a hash of the bytes. That's the whole trick of this file:
// we can ask ANY server for the bytes behind a CID, hash what comes back
// ourselves, and compare. If the hashes match, the bytes are exactly what
// the CID's creator published, no matter who served them. So gateways don't
// have to be trusted, only used.

const SHA2_256 = 0x12;
const IDENTITY = 0x00;
// IPFS blocks are capped around 1-2 MiB. Refusing bigger responses stops a
// malicious gateway from making us buffer unbounded data.
const MAX_BLOCK_BYTES = 2 * 1024 * 1024;

export type GetBlock = (cid: CID) => Promise<Uint8Array>;

export class BlockUnavailableError extends Error {}

export interface BlockFetcherOptions {
  /** Base URLs of trustless-capable gateways, tried in order. */
  gateways: string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Check that `bytes` really are the block that `cid` names.
async function verify(cid: CID, bytes: Uint8Array): Promise<boolean> {
  if (cid.multihash.code === SHA2_256) {
    const digest = await sha256.digest(bytes);
    return sameBytes(digest.digest, cid.multihash.digest);
  }
  throw new BlockUnavailableError(`unsupported hash function 0x${cid.multihash.code.toString(16)}`);
}

export function createBlockFetcher(opts: BlockFetcherOptions): GetBlock {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // Directory nodes get re-read for every file on a page, so keep recent blocks
  // in memory. Only small ones: big file chunks are read once and would just
  // evict the useful entries.
  const cache = new Map<string, Uint8Array>();
  const CACHE_MAX_ENTRIES = 500;
  const CACHE_MAX_BLOCK = 64 * 1024;

  return async function getBlock(cid: CID): Promise<Uint8Array> {
    // "Identity" CIDs embed the data in the CID itself: nothing to fetch.
    if (cid.multihash.code === IDENTITY) return cid.multihash.digest;

    const key = cid.toString();
    const hit = cache.get(key);
    if (hit) return hit;

    const errors: string[] = [];
    for (const gateway of opts.gateways) {
      try {
        // ?format=raw + this Accept header = the "trustless gateway" protocol:
        // give me the raw block, not a rendered web page.
        const res = await doFetch(`${gateway.replace(/\/$/, "")}/ipfs/${key}?format=raw`, {
          headers: { accept: "application/vnd.ipld.raw" },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "follow",
        });
        if (!res.ok) { errors.push(`${gateway}: HTTP ${res.status}`); continue; }

        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > MAX_BLOCK_BYTES) { errors.push(`${gateway}: block too large`); continue; }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > MAX_BLOCK_BYTES) { errors.push(`${gateway}: block too large`); continue; }

        if (!(await verify(cid, bytes))) {
          // The gateway sent the wrong bytes (broken or malicious). Don't use
          // them; try the next gateway.
          errors.push(`${gateway}: hash mismatch`);
          continue;
        }

        if (bytes.length <= CACHE_MAX_BLOCK) {
          if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
          cache.set(key, bytes);
        }
        return bytes;
      } catch (err) {
        if (err instanceof BlockUnavailableError) throw err;
        errors.push(`${gateway}: ${(err as Error).message}`);
      }
    }
    throw new BlockUnavailableError(`could not fetch ${key} (${errors.join("; ")})`);
  };
}
