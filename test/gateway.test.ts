import { test } from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../src/gateway.js";

const IPFS = "0xe301017012201d261cc098861d9952e6c8954801800e56aa34aabd8a9651b04b4e2498a45c53";

function setup(hex: `0x${string}` | null = IPFS) {
  const calls: string[] = [];
  const resolved: string[] = [];
  const gw = createGateway({
    baseDomain: "eth.photography",
    ipfsGateway: "https://gw.test",
    resolveContenthash: async (n) => { resolved.push(n); return hex; },
    fetch: (async (u: string) => {
      calls.push(u);
      return new Response("<h1>hi</h1>", { headers: { "content-type": "text/html", "set-cookie": "evil=1; Domain=.eth.photography" } });
    }) as any,
  });
  return { gw, calls, resolved };
}
const req = (url: string, init?: RequestInit) => new Request(url, init);

test("maps subdomain to ENS name and proxies content", async () => {
  const { gw, calls, resolved } = setup();
  const res = await gw(req("https://vitalik.eth.photography/a/b?x=1"));
  assert.equal(res.status, 200);
  assert.deepEqual(resolved, ["vitalik.eth"]);
  assert.match(calls[0], /^https:\/\/gw\.test\/ipfs\/bafy[a-z2-7]+\/a\/b\?x=1$/);
  assert.equal(await res.text(), "<h1>hi</h1>");
});

test("strips Set-Cookie from upstream and adds security headers", async () => {
  const res = await setup().gw(req("https://vitalik.eth.photography/"));
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("nested subdomain becomes ENS subname", async () => {
  const { gw, resolved } = setup();
  await gw(req("https://blog.vitalik.eth.photography/"));
  assert.deepEqual(resolved, ["blog.vitalik.eth"]);
});

test("404 when name has no contenthash", async () => {
  assert.equal((await setup(null).gw(req("https://nobody.eth.photography/"))).status, 404);
});

test("400 on invalid labels, 405 on POST, 404 on foreign host", async () => {
  const { gw } = setup();
  assert.equal((await gw(req("https://under_score.eth.photography/"))).status, 400);
  assert.equal((await gw(req("https://a.eth.photography/", { method: "POST" }))).status, 405);
  assert.equal((await gw(req("https://example.com/"))).status, 404);
});

test("501 for unsupported contenthash (swarm)", async () => {
  const swarm = "0xe40101fa011b20f5909b5286d9279a1f6a23d5155ddd72bb0f28f56b6b82c32de54a6529e6b1b0";
  assert.equal((await setup(swarm).gw(req("https://ens.eth.photography/"))).status, 501);
});

test("caches resolution between requests", async () => {
  const { gw, resolved } = setup();
  await gw(req("https://vitalik.eth.photography/"));
  await gw(req("https://vitalik.eth.photography/x"));
  assert.equal(resolved.length, 1);
});

test("apex serves landing page", async () => {
  assert.equal((await setup().gw(req("https://eth.photography/"))).status, 200);
});

test("upstream 429 becomes 502 and is never cached", async () => {
  const gw = createGateway({
    baseDomain: "eth.photography",
    resolveContenthash: async () => IPFS,
    fetch: (async () => new Response("slow down", { status: 429 })) as any,
  });
  const res = await gw(req("https://vitalik.eth.photography/"));
  assert.equal(res.status, 502);
  assert.equal(res.headers.get("cache-control"), null);
});
