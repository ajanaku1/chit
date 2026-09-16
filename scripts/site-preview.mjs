/**
 * The site from one machine, before the host: landing/public as static files
 * and the plain-JS API functions from api/ mounted at their paths, so a page
 * that reads /api/burn shows the live numbers exactly as it will on chit.tools.
 *
 *   node scripts/site-preview.mjs            → http://localhost:4173/burn/
 *   PORT=8080 node scripts/site-preview.mjs
 *
 * Only GET is served; the fleet functions need their env and are not mounted.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve("landing/public");
const port = Number(process.env.PORT ?? 4173);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff2": "font/woff2" };
/** The functions a visitor's browser reads without a body or a secret. */
const FUNCTIONS = { "/api/burn": "../api/burn.js", "/api/progress": "../api/progress.js" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  try {
    if (FUNCTIONS[url.pathname]) {
      const mod = await import(pathToFileURL(path.resolve("scripts", FUNCTIONS[url.pathname])).href);
      const r = await mod.GET(new Request(url));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    let s = await stat(file).catch(() => undefined);
    if (s?.isDirectory()) { if (!url.pathname.endsWith("/")) { res.writeHead(301, { location: url.pathname + "/" }); res.end(); return; } file = path.join(file, "index.html"); s = await stat(file).catch(() => undefined); }
    if (!s) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not here"); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(error instanceof Error ? error.message : String(error));
  }
});
server.listen(port, () => console.log(`preview at http://localhost:${port}/burn/  (ctrl-c stops it)`));
