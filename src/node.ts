// Local dev server: `npm run dev`, then visit http://vitalik.localhost:8787
// Adapts Node's http module to the web-standard Request/Response the gateway uses.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { buildGateway } from "./setup.js";

const handle = buildGateway({
  BASE_DOMAIN: process.env.BASE_DOMAIN ?? "localhost",
  IPFS_GATEWAYS: process.env.IPFS_GATEWAYS ?? "https://ipfs.filebase.io,https://trustless-gateway.link",
  ETH_RPC_URL: process.env.ETH_RPC_URL,
});

const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) Readable.fromWeb(response.body as any).pipe(res);
  else res.end();
}).listen(port, () => console.log(`gateway on http://localhost:${port}`));
