import {
  createPublicClient,
  decodeAbiParameters,
  encodeFunctionData,
  http,
  namehash,
  parseAbi,
  toHex,
} from "viem";
import { mainnet } from "viem/chains";
import { normalize, packetToBytes } from "viem/ens";

// A "client" is our connection to Ethereum. ENS lives on-chain, so we ask an
// Ethereum node (via an RPC URL) to run read-only contract calls for us.
// With no URL, viem uses a public default node: fine for learning, rate-limited.
const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.ETH_RPC_URL),
});

// The inner call: "what is the contenthash for this node?"
const contenthashAbi = parseAbi(["function contenthash(bytes32 node) view returns (bytes)"]);

// Resolver contracts come in two flavours:
//  - Classic: you call contenthash(node) on it directly.
//  - ENSIP-10 ("extended"): you call resolve(dnsEncodedName, innerCalldata) and it
//    answers *any* record request. Wildcard and offchain (CCIP-Read) resolvers
//    work this way, and a direct contenthash() call on them just reverts.
const resolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
]);
const ENSIP10_INTERFACE_ID = "0x9061b923";

// Returns the raw contenthash as hex (e.g. "0xe301017012...") or null if unset.
export async function getContenthashHex(name: string): Promise<`0x${string}` | null> {
  // normalize() enforces ENS naming rules (lowercase, unicode handling) and
  // throws on invalid names. Skipping it means look-alike names could resolve
  // differently than users expect.
  const normalized = normalize(name);

  // Hop 1: ask the ENS registry which resolver contract handles this name.
  const resolver = await client.getEnsResolver({ name: normalized });

  // Records are keyed by the "namehash": a 32-byte fingerprint of the name.
  const innerCall = encodeFunctionData({
    abi: contenthashAbi,
    functionName: "contenthash",
    args: [namehash(normalized)],
  });

  // Hop 2: ask the resolver. First find out which flavour it is.
  const isExtended = await client
    .readContract({
      address: resolver,
      abi: resolverAbi,
      functionName: "supportsInterface",
      args: [ENSIP10_INTERFACE_ID],
    })
    .catch(() => false);

  let hash: `0x${string}`;
  if (isExtended) {
    // resolve() returns ABI-encoded bytes wrapping our answer, so decode once
    // to unwrap the contenthash itself. packetToBytes DNS-encodes the name
    // ("vitalik.eth" -> length-prefixed labels), which is what ENSIP-10 expects.
    const answer = await client.readContract({
      address: resolver,
      abi: resolverAbi,
      functionName: "resolve",
      args: [toHex(packetToBytes(normalized)), innerCall],
    });
    [hash] = decodeAbiParameters([{ type: "bytes" }], answer);
  } else {
    hash = await client.readContract({
      address: resolver,
      abi: contenthashAbi,
      functionName: "contenthash",
      args: [namehash(normalized)],
    });
  }

  // An unset record comes back as empty bytes ("0x").
  return hash === "0x" ? null : hash;
}
