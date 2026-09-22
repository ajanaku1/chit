import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { chromium } from "playwright";

/**
 * The built Trade page, in a real browser, against a service that issues order
 * tokens: placing a 5-slice order costs the four signatures that lead to it
 * (list, holdings, quote, order) and none for the slices. The unit tests cover
 * the helpers; this is the count a trader sees, so a page-level regression
 * (a re-read after every poll, a dropped token) fails here and nowhere else.
 */

const execute = promisify(execFile);
const appRoot = fileURLToPath(new URL("../", import.meta.url));

const WALLET = "0x00000000000000000000000000000000000000aa";
const CAMPAIGN = `0x${"11".repeat(32)}`;
const TOKEN = `0x${"22".repeat(20)}`;
const FLEET_WALLETS = Array.from({ length: 5 }, (_, i) => `0x${String(i + 1).padStart(40, "0")}`);
const TYPES: Record<string, string> = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml" };

type Envelope = { action: string; auth?: unknown; orderToken?: string; body?: Record<string, unknown> };

/** One fake fleet service: every read answers, every slice is sponsored, and it logs how each request was authorised. */
const fakeService = (payload: Envelope): { status: number; body: unknown } => {
  const body = payload.body ?? {};
  const holdings = { holdings: FLEET_WALLETS.map((wallet) => ({ wallet, eth: "1000000000000000", tokens: {} })), symbols: {} };
  switch (payload.action) {
    case "challenge":
      return { status: 200, body: { challenge: "sign me", nonce: `n${Math.random()}`, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString() } };
    case "list":
      return { status: 200, body: { fleets: [{ campaign: CAMPAIGN, state: "Active", remaining: "100000000000000000", accounts: 5 }] } };
    case "status":
      return { status: 200, body: { state: "Active", draw: { amount: "1", spent: "0", remaining: "100000000000000000", dueAt: "", state: "Open" } } };
    case "holdings":
      return { status: 200, body: holdings };
    case "tokenQuote":
      return { status: 200, body: { symbol: "FLEET", hasPool: true, estimatedOut: "1000000000000000000", windowMs: 60_000, capWei: "10000000000000000" } };
    case "order": {
      const totalWei = String(body["totalWei"]);
      const order = { id: `0x${"33".repeat(32)}`, campaign: CAMPAIGN, token: TOKEN, totalWei, wallets: FLEET_WALLETS, entropy: body["entropy"], windowMs: 60_000, createdAt: body["createdAt"], owner: WALLET };
      const slices = FLEET_WALLETS.map((wallet, index) => ({ index, wallet, amountWei: String(BigInt(totalWei) / 5n), dueAt: new Date(Date.now() + index * 3_000).toISOString() }));
      return { status: 200, body: { order, slices, orderToken: "1.abc" } };
    }
    case "trade": {
      const executed = (body["pending"] as number[]).map((index) => ({ index, status: "sponsored", txHash: `0x${"44".repeat(32)}` }));
      return { status: 200, body: { executed, ...holdings } };
    }
    default:
      return { status: 409, body: { code: "state_invalid" } };
  }
};

/** Serves the built app and answers the fleet API from the fake service. */
const serve = async (dist: string, requests: string[]): Promise<{ origin: string; close: () => void }> => {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/fleet/")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw) as Envelope;
      requests.push(`${payload.action}${payload.auth ? ":signed" : payload.orderToken ? ":token" : ""}`);
      const answer = fakeService(payload);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
      return;
    }
    try {
      const file = join(dist, url.split("?")[0] ?? "/");
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
};

/**
 * A wallet that signs whatever it is asked and remembers each ask. Source text,
 * not a function: tsx wraps compiled functions in helpers the page does not have.
 */
const countingWallet = (wallet: string): string => `
  window.__signs = [];
  window.ethereum = {
    isMetaMask: true,
    request: async ({ method }) => {
      if (method === "personal_sign") { window.__signs.push(method); return "0x" + "11".repeat(65); }
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [${JSON.stringify(wallet)}];
      if (method === "eth_chainId") return "0x1";
      return null;
    },
    on: () => undefined,
    removeListener: () => undefined,
  };
`;

/** executablePath() is where the browser would be, installed or not; only the file on disk says it is. */
const browserInstalled = (): boolean => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
};

test("a 5-slice order costs the four signatures before it and none for its slices", { skip: !browserInstalled() && "Playwright's Chromium is not installed (npx playwright install chromium)" }, async () => {
  const dist = await mkdtemp(join(tmpdir(), "chit-trade-browser-"));
  const requests: string[] = [];
  let close = (): void => undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await execute(process.execPath, [join(appRoot, "build.mjs")], { env: { ...process.env, APP_OUTPUT: `${dist}/` } });
    const server = await serve(dist, requests);
    close = server.close;
    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(countingWallet(WALLET));

    await page.goto(`${server.origin}/trade.html`);
    // The wallet is already connected (eth_accounts answers), so the page asks before its first signed read.
    await page.click(".wallet-gate button");
    await page.waitForSelector("#fleet-switch option", { state: "attached" });
    await page.fill("#o-token", TOKEN);
    await page.locator("#o-token").blur();
    await page.waitForSelector("#o-place:enabled");
    await page.click("#o-place");
    await page.click("dialog.confirm-dialog button:last-of-type");
    // Slices are due three seconds apart, so they go out over several polls; the last one lands the order in the past list.
    await page.waitForSelector("#orders-past li", { timeout: 60_000 });

    const signs = await page.evaluate(() => (window as unknown as { __signs: string[] }).__signs);
    assert.deepEqual(pageErrors, []);
    assert.equal(signs.length, 4, `signatures asked: ${signs.length}; requests: ${requests.join(" ")}`);
    const trades = requests.filter((entry) => entry.startsWith("trade"));
    assert.ok(trades.length >= 2, `slices went out in one poll: ${requests.join(" ")}`);
    assert.deepEqual(trades, trades.map(() => "trade:token"), requests.join(" "));
    assert.equal(requests.filter((entry) => entry === "holdings:signed").length, 1, requests.join(" "));
    assert.match(await page.textContent("#orders-past") ?? "", /5\/5 slices/);
  } finally {
    await browser?.close();
    close();
    await rm(dist, { recursive: true, force: true });
  }
});
