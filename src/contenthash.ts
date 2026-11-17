import { CID } from "multiformats/cid";
import { base36 } from "multiformats/bases/base36";
import { hexToBytes } from "viem";

// A contenthash (EIP-1577) is: <namespace varint><content bytes>.
// The namespace says *which network* the content lives on:
//   0xe3 = IPFS, 0xe4 = Swarm, 0xe5 = IPNS, ...
// Inside, IPFS/IPNS content is a binary CID (content identifier).
const NS_IPFS = 0xe3;
const NS_IPNS = 0xe5;

// CID "codecs" we care about: how to interpret the CID's data.
const CODEC_LIBP2P_KEY = 0x72; // a public key => a real IPNS name
const CODEC_DAG_PB = 0x70; // with an identity multihash => a DNS name (DNSLink)
const MULTIHASH_IDENTITY = 0x00; // "the digest IS the data, not a hash of it"

export type Content =
  | { protocol: "ipfs"; id: string } // immutable content, id is a CID string
  | { protocol: "ipns"; id: string }; // mutable pointer: key (base36) or DNS name

export class UnsupportedContenthashError extends Error {}

// Read a varint (variable-length integer) off the front of a byte array.
// Returns [value, bytesConsumed]. Namespaces like 0xe3 take 2 bytes (e3 01)
// because varints use 7 bits per byte with a "more bytes follow" high bit.
function readVarint(bytes: Uint8Array): [number, number] {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < bytes.length; i++) {
    value |= (bytes[i] & 0x7f) << shift;
    if ((bytes[i] & 0x80) === 0) return [value, i + 1];
    shift += 7;
  }
  throw new UnsupportedContenthashError("truncated varint");
}

export function decodeContenthash(hex: `0x${string}`): Content {
  const bytes = hexToBytes(hex);
  const [namespace, used] = readVarint(bytes);
  const rest = bytes.subarray(used);

  switch (namespace) {
    case NS_IPFS: {
      const cid = CID.decode(rest);
      return { protocol: "ipfs", id: cid.toString() }; // CIDv1 => "bafy..." base32
    }
    case NS_IPNS: {
      const cid = CID.decode(rest);
      if (cid.code === CODEC_LIBP2P_KEY) {
        // Standard IPNS key. base36 keeps it lowercase, which matters for hostnames.
        return { protocol: "ipns", id: cid.toString(base36) };
      }
      if (cid.code === CODEC_DAG_PB && cid.multihash.code === MULTIHASH_IDENTITY) {
        // Trick used by tools like ENS apps: store a *domain name* as an identity
        // multihash. Gateways resolve it via the domain's DNSLink TXT record.
        return { protocol: "ipns", id: new TextDecoder().decode(cid.multihash.digest) };
      }
      throw new UnsupportedContenthashError("unrecognised IPNS CID");
    }
    default:
      throw new UnsupportedContenthashError(`unsupported contenthash namespace 0x${namespace.toString(16)}`);
  }
}
