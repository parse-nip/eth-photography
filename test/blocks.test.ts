import { test } from "node:test";
import assert from "node:assert/strict";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { BlockUnavailableError, createBlockFetcher } from "../src/ipfs/blocks.js";

async function blockOf(text: string) {
  const bytes = new TextEncoder().encode(text);
  return { bytes, cid: CID.createV1(0x55, await sha256.digest(bytes)) };
}

test("accepts bytes whose hash matches the CID", async () => {
  const { bytes, cid } = await blockOf("hello");
  const get = createBlockFetcher({ gateways: ["https://g1.test"], fetch: (async () => new Response(bytes)) as any });
  assert.deepEqual(await get(cid), bytes);
});

test("rejects tampered bytes and falls over to the next gateway", async () => {
  const { bytes, cid } = await blockOf("hello");
  const calls: string[] = [];
  const get = createBlockFetcher({
    gateways: ["https://evil.test", "https://good.test"],
    fetch: (async (u: string) => {
      calls.push(u);
      return new Response(u.startsWith("https://evil") ? new TextEncoder().encode("HACKED") : bytes);
    }) as any,
  });
  assert.deepEqual(await get(cid), bytes);
  assert.equal(calls.length, 2);
});

test("fails when every gateway lies or errors", async () => {
  const { cid } = await blockOf("hello");
  const get = createBlockFetcher({
    gateways: ["https://a.test", "https://b.test"],
    fetch: (async (u: string) => (u.startsWith("https://a") ? new Response("nope", { status: 429 }) : new Response("wrong"))) as any,
  });
  await assert.rejects(get(cid), BlockUnavailableError);
});

test("identity CIDs need no network", async () => {
  const data = new TextEncoder().encode("inline");
  const cid = CID.createV1(0x55, { code: 0x00, size: data.length, digest: data, bytes: new Uint8Array() } as any);
  const get = createBlockFetcher({ gateways: [], fetch: (async () => { throw new Error("no network"); }) as any });
  assert.deepEqual(await get(cid), data);
});

test("caches small blocks", async () => {
  const { bytes, cid } = await blockOf("cache me");
  let n = 0;
  const get = createBlockFetcher({ gateways: ["https://g.test"], fetch: (async () => { n++; return new Response(bytes); }) as any });
  await get(cid); await get(cid);
  assert.equal(n, 1);
});

test("retries a transient failure on a later round", async () => {
  const { bytes, cid } = await blockOf("flaky");
  let n = 0;
  const get = createBlockFetcher({
    gateways: ["https://g.test"],
    fetch: (async () => (++n === 1 ? new Response("busy", { status: 429 }) : new Response(bytes))) as any,
  });
  assert.deepEqual(await get(cid), bytes);
  assert.equal(n, 2);
});

test("persistent cache: verified blocks are stored and reused without the network", async () => {
  const { bytes, cid } = await blockOf("edge cached");
  const store = new Map<string, Uint8Array>();
  const persistentCache = {
    async match(url: string) { const b = store.get(url); return b ? new Response(b) : undefined; },
    async put(url: string, res: Response) { store.set(url, new Uint8Array(await res.arrayBuffer())); },
  };
  let n = 0;
  const mk = () => createBlockFetcher({
    gateways: ["https://g.test"], persistentCache,
    fetch: (async () => { n++; return new Response(bytes); }) as any,
  });
  await mk()(cid);                       // first isolate: network, then stored
  assert.equal(store.size, 1);
  assert.deepEqual(await mk()(cid), bytes); // a fresh fetcher (new isolate) hits the cache
  assert.equal(n, 1);
});

test("tampered bytes never reach the persistent cache", async () => {
  const { cid } = await blockOf("real");
  const store = new Map<string, Uint8Array>();
  const persistentCache = {
    async match() { return undefined; },
    async put(url: string, res: Response) { store.set(url, new Uint8Array(await res.arrayBuffer())); },
  };
  const get = createBlockFetcher({ gateways: ["https://g.test"], rounds: 1, persistentCache, fetch: (async () => new Response("FAKE")) as any });
  await assert.rejects(get(cid), BlockUnavailableError);
  assert.equal(store.size, 0);
});
