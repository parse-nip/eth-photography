import * as dagPB from "@ipld/dag-pb";
import { UnixFS } from "ipfs-unixfs";
import { CID } from "multiformats/cid";
import type { GetBlock } from "./blocks.js";

// IPFS stores files and folders as a graph of blocks ("a DAG"). The shape is
// defined by a format called UnixFS, layered on a block encoding called dag-pb:
//
//   directory block ──links──▶ "index.html" ──▶ file block ──links──▶ chunk, chunk, chunk
//                     └─────▶ "img"        ──▶ directory block ──▶ ...
//
// - A *directory* block has named links to children.
// - A small *file* is one block. A big file is split into chunks; the file
//   block has unnamed links to the chunks, in order.
// - Raw leaf blocks (codec 0x55) are chunk bytes with no wrapper at all.

const CODEC_RAW = 0x55;
const CODEC_DAG_PB = dagPB.code; // 0x70

export class UnsupportedUnixFsError extends Error {}
export class NotFoundError extends Error {}

export type Resolved =
  | { kind: "file"; cid: CID; size?: bigint }
  | { kind: "directory"; cid: CID };

// Load a block and work out what it is.
async function inspect(getBlock: GetBlock, cid: CID) {
  const bytes = await getBlock(cid);
  if (cid.code === CODEC_RAW) return { kind: "raw" as const, bytes };
  if (cid.code !== CODEC_DAG_PB) {
    throw new UnsupportedUnixFsError(`unsupported block codec 0x${cid.code.toString(16)}`);
  }
  const node = dagPB.decode(bytes);
  if (!node.Data) throw new UnsupportedUnixFsError("dag-pb node without UnixFS data");
  const unixfs = UnixFS.unmarshal(node.Data);
  return { kind: "unixfs" as const, node, unixfs };
}

// Walk down from `root` following `segments` (the URL path split on "/").
export async function resolvePath(getBlock: GetBlock, root: CID, segments: string[]): Promise<Resolved> {
  let cid = root;
  for (let i = 0; ; i++) {
    const block = await inspect(getBlock, cid);

    if (block.kind === "raw") {
      if (i < segments.length) throw new NotFoundError("path goes through a file");
      return { kind: "file", cid, size: BigInt(block.bytes.length) };
    }

    const { node, unixfs } = block;
    switch (unixfs.type) {
      case "file":
      case "raw":
        if (i < segments.length) throw new NotFoundError("path goes through a file");
        return { kind: "file", cid, size: unixfs.fileSize() };

      case "directory": {
        if (i === segments.length) return { kind: "directory", cid };
        const link = node.Links.find((l) => l.Name === segments[i]);
        if (!link) throw new NotFoundError(segments[i]);
        cid = link.Hash;
        break;
      }

      case "hamt-sharded-directory":
        // Very large directories are split across many blocks using a hash
        // trie (HAMT). Supporting it is a future milestone.
        throw new UnsupportedUnixFsError("sharded directories are not supported yet");

      default:
        throw new UnsupportedUnixFsError(`unsupported UnixFS type "${unixfs.type}"`);
    }
  }
}

// Stream a file's bytes in order. Each block is fetched lazily, only when the
// consumer (the HTTP response) is ready for more, and verified by getBlock.
async function* walkFile(getBlock: GetBlock, cid: CID): AsyncGenerator<Uint8Array> {
  const block = await inspect(getBlock, cid);
  if (block.kind === "raw") { yield block.bytes; return; }

  const { node, unixfs } = block;
  if (unixfs.type !== "file" && unixfs.type !== "raw") {
    throw new UnsupportedUnixFsError(`expected a file, found "${unixfs.type}"`);
  }
  // A file block can carry some bytes of its own, followed by its chunks.
  if (unixfs.data && unixfs.data.length > 0) yield unixfs.data;
  for (const link of node.Links) yield* walkFile(getBlock, link.Hash);
}

// Open a file for streaming. We fetch the FIRST chunk before returning, so that
// if the content is unreachable the caller finds out now and can send an honest
// error status. Once an HTTP response has started, a failure can only truncate it.
export async function openFile(getBlock: GetBlock, cid: CID): Promise<ReadableStream<Uint8Array>> {
  const it = walkFile(getBlock, cid);
  let pending: IteratorResult<Uint8Array> | undefined = await it.next(); // throws if unreachable

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = pending ?? (await it.next());
        pending = undefined;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err); // mid-stream failure: the client sees a truncated body
      }
    },
    cancel() { void it.return(undefined); }, // client went away: stop fetching blocks
  });
}
