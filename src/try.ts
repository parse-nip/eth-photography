import { createResolver } from "./resolve.js";
import { decodeContenthash } from "./contenthash.js";

const name = process.argv[2] ?? "vitalik.eth";
const hex = await createResolver(process.env.ETH_RPC_URL)(name);
console.log(name, "→", hex, hex ? decodeContenthash(hex) : null);
