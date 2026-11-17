import { getContenthashHex } from "./resolve.js";

const name = process.argv[2] ?? "vitalik.eth";
console.log(name, "→", await getContenthashHex(name));
