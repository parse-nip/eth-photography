import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/gateway.js";
import { cidToContenthashHex, MemStore } from "./helpers.js";

// A small site: /index.html, /about/index.html, /app.js, /big.txt (3 chunks), /my pic.jpg
async function site() {
  const s = new MemStore();
  const root = await s.dir({
    "index.html": await s.file("<h1>home</h1>"),
    about: await s.dir({ "index.html": await s.file("<h1>about</h1>") }),
    "app.js": await s.file("console.log(1)"),
    "big.txt": await s.chunked(["AAA", "BBB", "CCC"]),
    "my pic.jpg": await s.raw("jpegbytes"),
    empty: await s.dir({}),
  });
  return { s, root };
}

async function setup() {
  const { s, root } = await site();
  const resolved: string[] = [];
  const gw = createGateway({
    baseDomain: "eth.photography",
    resolveContenthash: async (n) => { resolved.push(n); return n === "nobody.eth" ? null : cidToContenthashHex(root); },
    getBlock: s.getBlock,
    resolveDnsLink: async (d) => (d === "app.example.org" ? root.toString() : null),
  });
  return { gw, s, root, resolved };
}
const req = (url: string, init?: RequestInit) => new Request(url, init);
const get = async (gw: (r: Request) => Promise<Response>, url: string) => {
  const res = await gw(req(url));
  return { res, body: await res.text() };
};

test("serves index.html at the root and sets headers", async () => {
  const { gw, resolved } = await setup();
  const { res, body } = await get(gw, "https://vitalik.eth.photography/");
  assert.equal(res.status, 200);
  assert.equal(body, "<h1>home</h1>");
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(resolved, ["vitalik.eth"]);
});

test("serves nested files and directory index", async () => {
  const { gw } = await setup();
  assert.equal((await get(gw, "https://a.eth.photography/app.js")).body, "console.log(1)");
  assert.equal((await get(gw, "https://a.eth.photography/about/")).body, "<h1>about</h1>");
});

test("redirects directory without trailing slash", async () => {
  const res = await (await setup()).gw(req("https://a.eth.photography/about?x=1"));
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/about/?x=1");
});

test("streams multi-chunk files in order", async () => {
  const { gw } = await setup();
  assert.equal((await get(gw, "https://a.eth.photography/big.txt")).body, "AAABBBCCC");
});

test("decodes percent-encoded filenames; raw-leaf files work", async () => {
  const { res, body } = await get((await setup()).gw, "https://a.eth.photography/my%20pic.jpg");
  assert.equal(res.status, 200);
  assert.equal(body, "jpegbytes");
  assert.equal(res.headers.get("content-type"), "image/jpeg");
});

test("404s: missing path, directory without index.html, name with no site", async () => {
  const { gw } = await setup();
  assert.equal((await gw(req("https://a.eth.photography/nope"))).status, 404);
  assert.equal((await gw(req("https://a.eth.photography/empty/"))).status, 404);
  assert.equal((await gw(req("https://nobody.eth.photography/"))).status, 404);
  assert.equal((await gw(req("https://a.eth.photography/app.js/extra"))).status, 404); // path through a file
});

test("ETag is the file CID and honours If-None-Match", async () => {
  const { gw } = await setup();
  const first = await gw(req("https://a.eth.photography/app.js"));
  const etag = first.headers.get("etag")!;
  assert.match(etag, /^"bafy/); // dag-pb file => CIDv1 "bafy..."
  const again = await gw(req("https://a.eth.photography/app.js", { headers: { "if-none-match": etag } }));
  assert.equal(again.status, 304);
});

test("HEAD returns headers and no body", async () => {
  const res = await (await setup()).gw(req("https://a.eth.photography/app.js", { method: "HEAD" }));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("never fetches a file's blocks until needed (HEAD touches no leaves)", async () => {
  const { gw, s } = await setup();
  await gw(req("https://a.eth.photography/big.txt", { method: "HEAD" }));
  assert.equal(s.fetches.length, 2); // root dir + big.txt node, no chunk blocks
});

test("DNSLink: ENS name storing a domain is resolved via TXT", async () => {
  const { s, root } = await site();
  const hexFor = (domain: string) => {
    const d = new TextEncoder().encode(domain);
    const bytes = new Uint8Array([0xe5, 0x01, 0x01, 0x70, 0x00, d.length, ...d]);
    return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
  };
  const gw = createGateway({
    baseDomain: "eth.photography",
    resolveContenthash: async () => hexFor("app.example.org"),
    getBlock: s.getBlock,
    resolveDnsLink: async (d) => (d === "app.example.org" ? root.toString() : null),
  });
  assert.equal((await get(gw, "https://x.eth.photography/")).body, "<h1>home</h1>");
});

test("400 invalid labels, 405 POST, 404 foreign host, apex 200", async () => {
  const { gw } = await setup();
  assert.equal((await gw(req("https://under_score.eth.photography/"))).status, 400);
  assert.equal((await gw(req("https://a.eth.photography/", { method: "POST" }))).status, 405);
  assert.equal((await gw(req("https://example.com/"))).status, 404);
  assert.equal((await gw(req("https://eth.photography/"))).status, 200);
});

test("501 for unsupported contenthash (swarm)", async () => {
  const { s } = await site();
  const gw = createGateway({
    baseDomain: "eth.photography",
    resolveContenthash: async () => "0xe40101fa011b20f5909b5286d9279a1f6a23d5155ddd72bb0f28f56b6b82c32de54a6529e6b1b0",
    getBlock: s.getBlock,
    resolveDnsLink: async () => null,
  });
  assert.equal((await gw(req("https://ens.eth.photography/"))).status, 501);
});

test("502 when blocks are unavailable on the network", async () => {
  const { root } = await site();
  const empty = new MemStore(); // knows no blocks
  const gw = createGateway({
    baseDomain: "eth.photography",
    resolveContenthash: async () => cidToContenthashHex(root),
    getBlock: empty.getBlock,
    resolveDnsLink: async () => null,
  });
  assert.equal((await gw(req("https://a.eth.photography/"))).status, 502);
});

test("caches name resolution between requests", async () => {
  const { gw, resolved } = await setup();
  await gw(req("https://a.eth.photography/"));
  await gw(req("https://a.eth.photography/app.js"));
  assert.equal(resolved.length, 1);
});

test("unreachable first chunk gives 502, not an empty 200", async () => {
  const { gw, s } = await setup();
  // Drop every raw leaf block, so the file node exists but its chunks do not.
  for (const [k] of s.blocks) if (k.startsWith("bafkrei")) s.blocks.delete(k);
  const res = await gw(req("https://a.eth.photography/big.txt"));
  assert.equal(res.status, 502);
});
