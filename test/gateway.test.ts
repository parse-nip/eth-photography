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

// ---- Range requests: big.txt is the 3 chunks "AAA" "BBB" "CCC" ----
const range = (gw: (r: Request) => Promise<Response>, r: string) =>
  gw(req("https://a.eth.photography/big.txt", { headers: { range: r } }));

test("Range: spans chunk boundaries and returns 206 with correct headers", async () => {
  const { gw } = await setup();
  const res = await range(gw, "bytes=2-5");
  assert.equal(res.status, 206);
  assert.equal(await res.text(), "ABBB");
  assert.equal(res.headers.get("content-range"), "bytes 2-5/9");
  assert.equal(res.headers.get("content-length"), "4");
});

test("Range: open-ended, suffix, and end clamped to file size", async () => {
  const { gw } = await setup();
  assert.equal(await (await range(gw, "bytes=7-")).text(), "CC");
  assert.equal(await (await range(gw, "bytes=-4")).text(), "BCCC");
  assert.equal(await (await range(gw, "bytes=6-999")).text(), "CCC");
});

test("Range: past the end is 416; garbage or multi-range falls back to the full file", async () => {
  const { gw } = await setup();
  const bad = await range(gw, "bytes=50-60");
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get("content-range"), "bytes */9");
  assert.equal(await (await range(gw, "bytes=0-1,4-5")).text(), "AAABBBCCC");
  assert.equal(await (await range(gw, "nonsense")).text(), "AAABBBCCC");
});

test("Range: skips chunks outside the range instead of downloading them", async () => {
  const { gw, s } = await setup();
  s.fetches.length = 0;
  await (await range(gw, "bytes=7-8")).text(); // only the last chunk "CCC" matters
  const leafFetches = s.fetches.filter((c) => c.startsWith("bafkrei"));
  assert.equal(leafFetches.length, 1);
});

test("200 responses advertise Accept-Ranges", async () => {
  const res = await (await setup()).gw(req("https://a.eth.photography/app.js"));
  assert.equal(res.headers.get("accept-ranges"), "bytes");
});

// ---- SPA fallback and 404.html ----
const nav = { accept: "text/html,application/xhtml+xml" };

test("SPA fallback: unknown extensionless path for a browser serves index.html with 200", async () => {
  const { gw } = await setup();
  const res = await gw(req("https://a.eth.photography/swap/eth", { headers: nav }));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<h1>home</h1>");
});

test("SPA fallback does not apply to missing files or non-browser requests", async () => {
  const { gw } = await setup();
  assert.equal((await gw(req("https://a.eth.photography/missing.js", { headers: nav }))).status, 404);
  assert.equal((await gw(req("https://a.eth.photography/swap/eth"))).status, 404); // curl / fetch(): no text/html
});

test("a site's own 404.html is served with status 404, in preference to SPA fallback", async () => {
  const s = new MemStore();
  const root = await s.dir({
    "index.html": await s.file("home"),
    "404.html": await s.file("custom not found"),
  });
  const gw = createGateway({
    baseDomain: "eth.photography",
    resolveContenthash: async () => cidToContenthashHex(root),
    getBlock: s.getBlock,
    resolveDnsLink: async () => null,
  });
  const res = await gw(req("https://a.eth.photography/nope", { headers: nav }));
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "custom not found");
});

// ---- IPNS through the whole gateway ----
import { buildRecord, newKey } from "./ipns-helpers.js";
import { createIpnsResolver } from "../src/ipfs/ipns.js";

// ENS contenthash for an IPNS key: 0xe5 0x01 + CIDv1(libp2p-key). The name's CID bytes come from the base36 name.
import { base36 } from "multiformats/bases/base36";
import { CID } from "multiformats/cid";
const ipnsHex = (name: string): `0x${string}` => {
  const bytes = new Uint8Array([0xe5, 0x01, ...CID.parse(name, base36).bytes]);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
};

async function ipnsSetup(makeRecord: (key: ReturnType<typeof newKey>, root: string) => Uint8Array) {
  const { s, root } = await site();
  const key = newKey();
  const gw = createGateway({
    baseDomain: "eth.photography",
    resolveContenthash: async () => ipnsHex(key.name),
    getBlock: s.getBlock,
    resolveDnsLink: async () => null,
    resolveIpns: createIpnsResolver({
      sources: ["https://r.test/ipns"],
      fetch: (async () => new Response(makeRecord(key, root.toString()))) as any,
    }),
  });
  return gw;
}

test("IPNS: ENS name -> key -> verified record -> site", async () => {
  const gw = await ipnsSetup((k, root) => buildRecord(k, `/ipfs/${root}`));
  const { res, body } = await get(gw, "https://app.eth.photography/about/");
  assert.equal(res.status, 200);
  assert.equal(body, "<h1>about</h1>");
});

test("IPNS: record pointing into a sub-directory serves that directory as the site root", async () => {
  const gw = await ipnsSetup((k, root) => buildRecord(k, `/ipfs/${root}/about`));
  assert.equal((await get(gw, "https://app.eth.photography/")).body, "<h1>about</h1>");
});

test("IPNS: forged record gives 502, never attacker content", async () => {
  const attacker = newKey();
  const gw = await ipnsSetup((k, root) => buildRecord(k, `/ipfs/${root}`, { signWith: attacker.secretKey }));
  assert.equal((await gw(req("https://app.eth.photography/"))).status, 502);
});

test("IPNS: expired record gives 502", async () => {
  const gw = await ipnsSetup((k, root) => buildRecord(k, `/ipfs/${root}`, { validUntil: new Date(Date.now() - 1000) }));
  assert.equal((await gw(req("https://app.eth.photography/"))).status, 502);
});
