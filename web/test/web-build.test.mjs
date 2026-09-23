import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CAPS_UNTIL_AUDIT, GATE_SENTENCE, betaFacts } from "../../app/chain-target.mjs";

/**
 * The new stack, held to what app/test holds the old build to. Both hosts are built here from the
 * same source with nothing but FLEET_CHAIN_ID between them (next build, the real one), and what they
 * would serve is read back from the build: the prerendered pages, the route bodies, the bundles.
 *
 *   - FR-006: on the beta, one strip before the masthead of every app page, in the HTML itself, with
 *     the three facts and no control; the statement beside the deposit amount (FR-007) and the
 *     gate's sentence (T058) are there too; on the testnet, none of it.
 *   - FR-001, T059: a page states its own chain's draw cap before the pool answers.
 *   - T081, FR-019: each host names its own chain, its own RPC, its own session factory, and
 *     never the other's (two-hosts.test.ts, for this build).
 *   - Every element the app's logic looks up by id is on the page it was on in app/*.html.
 */

const run = promisify(execFile);
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const appRoot = fileURLToPath(new URL("../../app/", import.meta.url));
const nextBin = join(webRoot, "node_modules/next/dist/bin/next");
const PAGES = ["balance", "fleet", "fleet-dashboard", "fleet-privacy", "trade", "sessions"];
const MAINNET_RPC = "rpc.mainnet.chain.robinhood.com";
const TESTNET_RPC = "rpc.testnet.chain.robinhood.com";
const TESTNET_FACTORY = "0xe6abb3aba7625c215f805ddc762e1148860796be";

const builds = new Map();
/** One build per chain for the whole file, each in its own dist folder. */
const buildFor = (chainId, env = {}) => {
  if (!builds.has(chainId)) {
    const dist = `.next-test-${chainId}`;
    builds.set(chainId, (async () => {
      await rm(join(webRoot, dist), { recursive: true, force: true });
      await run(process.execPath, [nextBin, "build"], {
        cwd: webRoot,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: dist, FLEET_CHAIN_ID: chainId, ...env },
        maxBuffer: 64 * 1024 * 1024,
      });
      return join(webRoot, dist);
    })());
  }
  return builds.get(chainId);
};
const beta = () => buildFor("4663", { FLEET_TESTNET_URL: "https://testnet.chit.tools" });
const play = () => buildFor("46630");
after(() => Promise.all(["4663", "46630"].map((c) => rm(join(webRoot, `.next-test-${c}`), { recursive: true, force: true }))));

/** React's text as a reader sees it: no empty comments between text runs, entities decoded. */
const text = (html) => html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const page = async (dist, name) => text(await readFile(join(dist, "server/app/app", `${name}.html`), "utf8"));
const body = async (dist, route) => readFile(join(dist, "server/app/app", `${route}.body`), "utf8");

/** Everything the host would send: prerendered pages and payloads, route bodies, bundles and styles. Source maps are left out. */
const served = async (dist) => {
  const out = [];
  for (const dir of [join(dist, "static"), join(dist, "server/app"), join(webRoot, "public")]) {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || e.name.endsWith(".map")) continue;
      const inServer = dir.endsWith("app") && dir.includes("server");
      if (inServer && !/\.(html|body|rsc|meta)$/.test(e.name)) continue;
      out.push(await readFile(join(e.parentPath ?? dir, e.name), "utf8").catch(() => ""));
    }
  }
  return out.join("\n");
};

test("on the beta the strip is in the HTML of every app page, before the masthead, with the three facts and nothing to close it; on testnet it is not", { timeout: 600_000 }, async () => {
  for (const [dist, isBeta] of [[await beta(), true], [await play(), false]]) {
    for (const name of PAGES) {
      const html = await page(dist, name);
      const strips = html.match(/<p id="beta-note" class="beta-note" role="note">/g) ?? [];
      assert.equal(strips.length, isBeta ? 1 : 0, `${name}: ${strips.length} strip(s)`);
      if (!isBeta) continue;
      const strip = /<p id="beta-note"[^>]*>([\s\S]*?)<\/p>/.exec(html)[1];
      assert.match(strip, /Beta on Robinhood Chain\./);
      for (const fact of [...betaFacts("1"), CAPS_UNTIL_AUDIT]) assert.ok(strip.includes(fact), `${name}: the strip omits ${fact}`);
      assert.doesNotMatch(strip, /<button|<input|<a /, `${name}: the strip has a control in it`);
      assert.ok(html.indexOf('id="beta-note"') < html.indexOf('<header class="masthead">'), `${name}: the strip is not before the masthead`);
    }
  }
});

test("the statement beside the deposit amount and the gate's sentence are in the Balance page's HTML on the beta, and hidden on testnet", { timeout: 600_000 }, async () => {
  const b = await page(await beta(), "balance");
  const custody = /<p id="deposit-custody"([^>]*)>([^<]*)<\/p>/.exec(b);
  assert.ok(custody, "no statement beside the amount");
  assert.doesNotMatch(custody[1], /\bhidden\b/, "the statement beside the amount is hidden");
  for (const fact of betaFacts("1")) assert.ok(custody[2].includes(fact), `the deposit form omits ${fact}`);
  assert.ok(b.indexOf('id="deposit-custody"') < b.indexOf('id="deposit-sizes"'), "the statement is not beside the amount");
  const gate = /<p id="deposit-gate-note"([^>]*)>([^<]*)<\/p>/.exec(b);
  assert.ok(gate && !/\bhidden\b/.test(gate[1]) && gate[2] === GATE_SENTENCE, "the gate's sentence is not beside the deposit form");

  const p = await page(await play(), "balance");
  assert.match(/<p id="deposit-custody"([^>]*)>/.exec(p)[1], /\bhidden\b/, "off the beta the statement should stay hidden");
  assert.match(/<p id="deposit-gate-note"([^>]*)>/.exec(p)[1], /\bhidden\b/);
});

test("each page states its own chain's draw cap before the pool answers", { timeout: 600_000 }, async () => {
  const b = await beta(), p = await play();
  assert.match(await page(b, "balance"), /data-led="0\.05" data-unit="ETH" data-cap="draw">0\.05 ETH/);
  assert.doesNotMatch(await page(b, "balance"), /data-cap="draw">0\.2 ETH/);
  assert.match(await page(b, "fleet"), /aria-label="This draw against the 0\.05 ETH cap"/);
  assert.match(await page(p, "balance"), /data-led="0\.2" data-unit="ETH" data-cap="draw">0\.2 ETH/);
  assert.match(await page(p, "fleet"), /aria-label="This draw against the 0\.2 ETH cap"/);
});

test("the two hosts are one source and one variable, and neither offers the other's chain or funds", { timeout: 600_000 }, async () => {
  const b = await beta(), p = await play();
  const betaTarget = JSON.parse(await body(b, "chain-target.json")), playTarget = JSON.parse(await body(p, "chain-target.json"));
  assert.equal(betaTarget.chainId, 4663);
  assert.equal(playTarget.chainId, 46630);
  assert.deepEqual(betaTarget.rpcUrls, [`https://${MAINNET_RPC}`]);
  assert.deepEqual(playTarget.rpcUrls, [`https://${TESTNET_RPC}`]);
  assert.equal(betaTarget.beta, true);
  assert.equal(playTarget.beta, false);
  assert.doesNotMatch(await body(b, "chain-target.json"), /\b46630\b/, "the beta's target names one chain");
  assert.doesNotMatch(await body(p, "chain-target.json"), /\b4663\b/, "the playground's target names one chain");

  assert.deepEqual(JSON.parse(await body(p, "session-target.json")), { chainId: 46630, sessionFactory: TESTNET_FACTORY });
  assert.deepEqual(JSON.parse(await body(b, "session-target.json")), { chainId: 4663, sessionFactory: "" }, "no factory on 4663 until one is deployed");

  const betaServed = await served(b), playServed = await served(p);
  // What a page starts from before chain-target.json is read is the chain its bundle was built for.
  const defaultOf = (all, chainId, rpc) =>
    new RegExp(`chainId:\\s*${chainId}\\s*,\\s*chainName:\\s*"[^"]+"\\s*,\\s*rpcUrls:\\s*\\["https://${rpc.replace(/\./g, "\\.")}"\\]`).test(all);
  assert.ok(defaultOf(betaServed, 4663, MAINNET_RPC), "the beta's bundles start on mainnet");
  assert.ok(defaultOf(playServed, 46630, TESTNET_RPC), "the playground's bundles start on testnet");
  assert.ok(!playServed.includes(MAINNET_RPC), "the playground names the mainnet RPC nowhere at all");
  assert.ok(!betaServed.includes(TESTNET_FACTORY), "the testnet factory is nowhere in the beta's deploy");
  assert.ok(betaServed.includes("https://testnet.chit.tools"), "the beta links to the playground for a wallet below the threshold");
  assert.ok(!playServed.includes("chit.tools/app"), "the playground does not send anyone to the beta");
});

test("every element the app's logic finds by id is on the page it was on in app/*.html, on both hosts", { timeout: 600_000 }, async () => {
  for (const dist of [await beta(), await play()]) {
    for (const name of PAGES) {
      const original = await readFile(join(appRoot, `${name}.html`), "utf8");
      const ids = [...original.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]).filter((id) => id !== "beta-note");
      const html = await page(dist, name);
      const missing = ids.filter((id) => !html.includes(`id="${id}"`));
      assert.deepEqual(missing, [], `${name}: ids the logic cannot find`);
    }
  }
});

/**
 * The site and the app can be two hosts (chit.tools is the site, the app is served
 * elsewhere), so every "open the app" link is the configured origin and not this
 * site's own path. A hardcoded /app/... sends a visitor to a host that may not serve
 * the app at all, which is how the first deploy of this site shipped.
 */
test("no user-facing link to the app is hardcoded to this site", async () => {
  const chain = await readFile(join(webRoot, "components/chain.tsx"), "utf8");
  assert.match(chain, /NEXT_PUBLIC_APP_ORIGIN/, "the app's origin comes from the build's environment");
  assert.match(chain, /export const APP_HREF/, "and the entry is named once");
  assert.match(chain, /APP_HREF = `\$\{APP_ORIGIN\}\/app\/balance`/, "the link a visitor sees carries no file name");
  // The other host serves the built app as static pages (balance.html), so it rewrites the
  // clean path to them; this site rewrites the other way. One spelling works on both, and
  // the one a visitor reads is the clean one.
  const root = JSON.parse(await readFile(join(webRoot, "../vercel.json"), "utf8"));
  const rewrite = (root.rewrites ?? []).find((r) => r.destination === "/app/$1.html");
  assert.ok(rewrite, "the host that serves the built app must rewrite /app/:page to the page");
  for (const page of ["balance", "fleet", "fleet-dashboard", "fleet-privacy", "sessions", "trade"]) {
    assert.match(rewrite.source, new RegExp(`\\b${page}\\b`), `${page} is not covered by the rewrite`);
  }

  for (const file of ["components/scenes.tsx", "components/chrome.tsx"]) {
    const text = await readFile(join(webRoot, file), "utf8");
    const hardcoded = [...text.matchAll(/href="\/app\/(?!logo|favicon)[^"]*"/g)].map((m) => m[0]);
    assert.deepEqual(hardcoded, [], `${file} links into the app by path instead of APP_HREF`);
  }
});

/**
 * The site had no icon at all after it moved to web/: the old landing's files were served
 * from landing/public, which this project does not build. Next serves app/icon.svg,
 * app/favicon.ico and app/apple-icon.png by file convention and writes the links itself,
 * so the test is that the files are there and the links reach the page.
 */
test("the site carries its icon, in the page and on disk", { timeout: 600_000 }, async () => {
  for (const file of ["app/icon.svg", "app/favicon.ico", "app/apple-icon.png"]) {
    await assert.doesNotReject(readFile(join(webRoot, file)), `${file} is missing, so the site has no icon`);
  }
  const dist = await buildFor("46630");
  const html = await readFile(join(dist, "server/app/index.html"), "utf8");
  assert.match(html, /<link rel="icon"[^>]*favicon\.ico/, "no .ico link in the page");
  assert.match(html, /<link rel="icon"[^>]*icon\.svg/, "no svg icon link in the page");
  assert.match(html, /<link rel="apple-touch-icon"/, "no apple touch icon in the page");
});
