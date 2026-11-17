import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeContenthash, UnsupportedContenthashError } from "../src/contenthash.js";

// Real values read from mainnet by src/try.ts.
test("decodes IPFS (vitalik.eth)", () => {
  const c = decodeContenthash("0xe301017012201d261cc098861d9952e6c8954801800e56aa34aabd8a9651b04b4e2498a45c53");
  assert.equal(c.protocol, "ipfs");
  assert.match(c.id, /^bafy[a-z2-7]+$/); // CIDv1, base32
});

test("decodes IPNS identity-multihash as a DNS name (uniswap.eth)", () => {
  const c = decodeContenthash("0xe5010170000f6170702e756e69737761702e6f7267");
  assert.deepEqual(c, { protocol: "ipns", id: "app.uniswap.org" });
});

test("rejects Swarm (ens.eth) as unsupported", () => {
  assert.throws(
    () => decodeContenthash("0xe40101fa011b20f5909b5286d9279a1f6a23d5155ddd72bb0f28f56b6b82c32de54a6529e6b1b0"),
    UnsupportedContenthashError,
  );
});
