import * as dagPB from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type { GetBlock } from "../src/ipfs/blocks.js";
import { BlockUnavailableError } from "../src/ipfs/blocks.js";

// An in-memory IPFS: blocks keyed by CID string. Builders below make real
// UnixFS structures, the same shapes `ipfs add` produces.
export class MemStore {
  blocks = new Map<string, Uint8Array>();
  fetches: string[] = [];

  async put(code: number, bytes: Uint8Array): Promise<CID> {
    const cid = CID.createV1(code, await sha256.digest(bytes));
    this.blocks.set(cid.toString(), bytes);
    return cid;
  }
  /** A raw leaf block (codec 0x55): just bytes. */
  raw(data: string | Uint8Array) {
    return this.put(0x55, typeof data === "string" ? new TextEncoder().encode(data) : data);
  }
  /** A single-block UnixFS file wrapped in dag-pb. */
  async file(data: string) {
    const bytes = new TextEncoder().encode(data);
    const node = dagPB.prepare({ Data: new UnixFS({ type: "file", data: bytes }).marshal(), Links: [] });
    return this.put(dagPB.code, dagPB.encode(node));
  }
  /** A multi-chunk file: one file node linking to raw chunk blocks in order. */
  async chunked(chunks: string[]) {
    const leaves = await Promise.all(chunks.map((c) => this.raw(c)));
    const sizes = chunks.map((c) => BigInt(new TextEncoder().encode(c).length));
    const fs = new UnixFS({ type: "file", blockSizes: sizes });
    const node = dagPB.prepare({
      Data: fs.marshal(),
      Links: leaves.map((cid, i) => ({ Hash: cid, Name: "", Tsize: Number(sizes[i]) })),
    });
    return this.put(dagPB.code, dagPB.encode(node));
  }
  /** A UnixFS directory. */
  async dir(entries: Record<string, CID>) {
    const links = Object.entries(entries)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([Name, Hash]) => ({ Name, Hash, Tsize: 0 }));
    const node = dagPB.prepare({ Data: new UnixFS({ type: "directory" }).marshal(), Links: links });
    return this.put(dagPB.code, dagPB.encode(node));
  }

  getBlock: GetBlock = async (cid) => {
    if (cid.multihash.code === 0) return cid.multihash.digest;
    this.fetches.push(cid.toString());
    const b = this.blocks.get(cid.toString());
    if (!b) throw new BlockUnavailableError(`missing ${cid}`);
    return b;
  };
}

export const cidToContenthashHex = (cid: CID): `0x${string}` => {
  // 0xe3 0x01 = "ipfs" namespace varint, followed by the binary CID.
  const bytes = new Uint8Array([0xe3, 0x01, ...cid.bytes]);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};
