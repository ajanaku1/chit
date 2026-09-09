/**
 * Serves the built site and the Fleet API on one local origin, so the real
 * pages can be clicked through against the live testnet before anything is
 * deployed. Same handlers Vercel runs; no Vercel account needed.
 *
 *   npm run dev:local          then open http://localhost:3000
 *
 * Reads DEPLOYER_PRIVATE_KEY and FLEET_POOL_ADDRESS from .env, exactly as the
 * hosted service does. FLEET_ORIGIN is set to this server so signed challenges
 * name the origin the browser is actually on.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = new URL("../public/", import.meta.url).pathname;
process.env.FLEET_ORIGIN ??= `http://localhost:${PORT}`;

// The pool address comes from the recorded deployment unless the environment
// names one, so local runs need no edit to .env and cannot drift from what was
// actually deployed.
if (!process.env.FLEET_POOL_ADDRESS) {
  const record = JSON.parse(await readFile(new URL("../deployments/fleet-46630.json", import.meta.url), "utf8"));
  if (record.pool?.address) process.env.FLEET_POOL_ADDRESS = record.pool.address;
}

const ROUTES = {
  "/api/fleet/campaign": "../api/fleet/campaign.js",
  "/api/fleet/buy": "../api/fleet/buy.js",
  "/api/fleet/control": "../api/fleet/control.js",
  "/api/fleet/balance": "../api/fleet/balance.js",
  "/api/fleet/sweep": "../api/fleet/sweep.js",
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
};

const handlers = new Map();
for (const [route, file] of Object.entries(ROUTES)) {
  handlers.set(route, await import(new URL(file, import.meta.url).href));
}

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", `http://localhost:${PORT}`);
    const route = handlers.get(url.pathname);

    if (route) {
      const body = request.method === "POST" ? await readBody(request) : undefined;
      const handler = request.method === "GET" ? route.GET : route.POST;
      if (!handler) {
        response.writeHead(405).end();
        return;
      }
      const result = await handler(
        new Request(url.href, {
          method: request.method,
          headers: Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
          ...(body ? { body } : {}),
        }),
      );
      const text = await result.text();
      console.log(`${request.method} ${url.pathname} -> ${result.status} ${text.slice(0, 120)}`);
      response.writeHead(result.status, { "content-type": "application/json" }).end(text);
      return;
    }

    // Static: the assembled site, with /app/x -> /app/x.html for bare paths.
    let file = join(ROOT, normalize(url.pathname).replace(/^(\.\.[/\\])+/, ""));
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      if (!extname(file)) file += ".html";
    }
    try {
      const content = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(content);
    } catch {
      console.log(`404 ${url.pathname}`);
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  })().catch((error) => {
    console.error("request failed", error);
    if (!response.headersSent) response.writeHead(500).end("server error");
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use, most likely by an earlier run of this server.`);
    console.error(`  free it:        lsof -ti:${PORT} | xargs kill`);
    console.error(`  or pick another: PORT=3100 npm run dev:local`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  const pool = process.env.FLEET_POOL_ADDRESS ?? "(none recorded: pool actions will answer 503)";
  console.log(`Chit local server  http://localhost:${PORT}`);
  console.log(`  balance page     http://localhost:${PORT}/app/balance.html`);
  console.log(`  fleet wizard     http://localhost:${PORT}/app/fleet.html`);
  console.log(`  pool             ${pool}`);
  console.log(`  operator key     ${process.env.DEPLOYER_PRIVATE_KEY ? "set" : "MISSING"}`);
});
