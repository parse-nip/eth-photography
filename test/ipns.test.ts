import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { UnsupportedContenthashError } from "../src/contenthash.js";
import { createIpnsResolver, IpnsError, IpnsNotFoundError, verifyRecord } from "../src/ipfs/ipns.js";
import { buildRecord, newKey } from "./ipns-helpers.js";

const CID_A = "bafybeia5eyombgegdwmvfzwisveadaaok2vdjkv5rklfdmcljysjrjc4km";
const CID_B = "bafybeid2wwebk7sxr4477x5hic5ujxfy5ghvywfpew7k2qpyd2mwivoj4m";

test("accepts a genuine record and extracts the CID", () => {
  const k = newKey();
  const r = verifyRecord(k.name, buildRecord(k, `/ipfs/${CID_A}`, { sequence: 7 }));
  assert.equal(r.cid, CID_A);
  assert.equal(r.sequence, 7n);
  assert.deepEqual(r.path, []);
});

test("keeps a sub-path from /ipfs/<cid>/dist", () => {
  const k = newKey();
  assert.deepEqual(verifyRecord(k.name, buildRecord(k, `/ipfs/${CID_A}/dist/web`)).path, ["dist", "web"]);
});

test("rejects tampered data (signature no longer matches)", () => {
  const k = newKey();
  assert.throws(() => verifyRecord(k.name, buildRecord(k, `/ipfs/${CID_A}`, { tamper: true })), /signature|malformed/);
});

test("rejects a record signed by a different key than the name's", () => {
  const k = newKey(), attacker = newKey();
  assert.throws(
    () => verifyRecord(k.name, buildRecord(k, `/ipfs/${CID_A}`, { signWith: attacker.secretKey })),
    /invalid signature/,
  );
});

test("rejects a record that is validly signed for a DIFFERENT name", () => {
  const a = newKey(), b = newKey();
  assert.throws(() => verifyRecord(a.name, buildRecord(b, `/ipfs/${CID_A}`)), /invalid signature/);
});

test("rejects expired records", () => {
  const k = newKey();
  const old = buildRecord(k, `/ipfs/${CID_A}`, { validUntil: new Date(Date.now() - 60_000) });
  assert.throws(() => verifyRecord(k.name, old), /expired/);
});

test("rejects garbage, truncated and oversized input without crashing", () => {
  const k = newKey();
  assert.throws(() => verifyRecord(k.name, new Uint8Array([1, 2, 3, 4])), IpnsError);
  assert.throws(() => verifyRecord(k.name, buildRecord(k, `/ipfs/${CID_A}`).slice(0, 20)), IpnsError);
  assert.throws(() => verifyRecord(k.name, new Uint8Array(20_000)), /too large/);
});

test("rejects a bogus CID inside a validly signed record", () => {
  const k = newKey();
  assert.throws(() => verifyRecord(k.name, buildRecord(k, "/ipfs/not-a-cid")), /invalid CID/);
});

test("rejects records pointing at another IPNS name as unsupported", () => {
  const k = newKey();
  assert.throws(() => verifyRecord(k.name, buildRecord(k, "/ipns/k51qzi5uqu5d")), UnsupportedContenthashError);
});

test("rejects names that aren't ed25519 IPNS keys", () => {
  assert.throws(() => verifyRecord("not-a-name", new Uint8Array()), IpnsError);
  assert.throws(() => verifyRecord(CID_A, new Uint8Array()), IpnsError); // a content CID, not a key name
});

// ---- resolver: asks many sources, trusts none ----
const respond = (map: Record<string, Uint8Array | number>) =>
  (async (url: string) => {
    const hit = Object.entries(map).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (hit === undefined || typeof hit === "number") return new Response("nope", { status: hit ?? 404 });
    return new Response(hit);
  }) as any;

test("resolver picks the highest sequence among valid records", async () => {
  const k = newKey();
  const resolve = createIpnsResolver({
    sources: ["https://a.test/ipns", "https://b.test/ipns"],
    fetch: respond({
      "https://a.test": buildRecord(k, `/ipfs/${CID_A}`, { sequence: 5 }),
      "https://b.test": buildRecord(k, `/ipfs/${CID_B}`, { sequence: 9 }),
    }),
  });
  assert.equal((await resolve(k.name)).cid, CID_B);
});

test("resolver ignores a forged record from a malicious source and uses the honest one", async () => {
  const k = newKey(), attacker = newKey();
  const forged = buildRecord(k, `/ipfs/${CID_B}`, { sequence: 999, signWith: attacker.secretKey }); // higher sequence, bad signature
  const resolve = createIpnsResolver({
    sources: ["https://evil.test/ipns", "https://good.test/ipns"],
    fetch: respond({ "https://evil.test": forged, "https://good.test": buildRecord(k, `/ipfs/${CID_A}`, { sequence: 2 }) }),
  });
  assert.equal((await resolve(k.name)).cid, CID_A);
});

test("resolver reports not-found when no source has a valid record", async () => {
  const k = newKey();
  const resolve = createIpnsResolver({ sources: ["https://a.test/ipns", "https://b.test/ipns"], fetch: respond({ "https://a.test": 404, "https://b.test": 500 }) });
  await assert.rejects(resolve(k.name), IpnsNotFoundError);
});

test("resolver sends the signed-record Accept header", async () => {
  const k = newKey();
  let accept = "";
  const resolve = createIpnsResolver({
    sources: ["https://a.test/ipns"],
    fetch: (async (_u: string, init: RequestInit) => { accept = (init.headers as any).accept; return new Response(buildRecord(k, `/ipfs/${CID_A}`)); }) as any,
  });
  await resolve(k.name);
  assert.equal(accept, "application/vnd.ipfs.ipns-record");
});

void ed25519;
