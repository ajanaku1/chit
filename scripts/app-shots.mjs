// Renders every app page at the redesign's viewports and fails on horizontal
// overflow or console errors. Needs the local server (npm run dev:local) and
// Playwright's Chromium (npx playwright install chromium).
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const BASE = process.env.APP_URL ?? "http://localhost:3000/app/";
const OUT = new URL("../app/evidence/", import.meta.url);
const PAGES = ["balance", "fleet", "fleet-dashboard", "fleet-privacy"];
const VIEWPORTS = [
  { name: "1606", width: 1606, height: 1161 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1024", width: 1024, height: 1180 },
  { name: "390", width: 390, height: 844 },
  { name: "320", width: 320, height: 640 },
  { name: "1440-reduced", width: 1440, height: 900, reducedMotion: "reduce" },
];

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const failures = [];
for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: viewport.reducedMotion ?? "no-preference",
  });
  for (const page of PAGES) {
    const tab = await context.newPage();
    const errors = [];
    tab.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(`${BASE}${page}.html`, { waitUntil: "networkidle" });
    // Sections reveal once as they scroll into view; a full-page capture never
    // scrolls, so walk the page first or they are photographed blank.
    await tab.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      window.scrollTo(0, 0);
    });
    await tab.waitForTimeout(1200);
    const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await tab.screenshot({ path: new URL(`${page}-${viewport.name}.png`, OUT).pathname, fullPage: true });
    if (overflow > 0) failures.push(`${page} @ ${viewport.name}: ${overflow}px of horizontal overflow`);
    for (const error of errors) failures.push(`${page} @ ${viewport.name}: console error: ${error}`);
    await tab.close();
  }
  await context.close();
}

// Second pass: a wallet is already connected, with a fresh cached balance and
// a fleet snapshot, so Balance and the Control Room render their live state
// instead of the signed-out placeholders the first pass sees. Any request
// that escapes the local origin is aborted and counted as a failure, same as
// a layout overflow or a console error.
const CONNECTED_PAGES = ["balance", "fleet-dashboard"];
const CONNECTED_VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "320", width: 320, height: 640 },
];
const ADDRESS = "0x1111111111111111111111111111111111111111";
const ACCOUNTS = Array.from({ length: 5 }, (_, i) => `0x${String(i + 1).repeat(40)}`);

const seedConnected = ({ addr, accounts }) => {
  window.ethereum = {
    request: async ({ method }) =>
      method === "eth_chainId" ? "0xb626" : method === "eth_accounts" ? [addr] : null,
    on() {},
  };
  sessionStorage.setItem("chit-fleet-wallet", addr);
  sessionStorage.setItem(
    `chit-balance:${addr}`,
    JSON.stringify({
      available: "49979000000000000",
      deposited: "50000000000000000",
      spent: "21000000000000",
      openDraws: "0",
      headroom: { sizes: [], perTraderRemaining: "450000000000000000", poolRemaining: "1000000000000000000" },
      exit: {},
      pool: { paused: false },
      savedAt: Date.now(),
    }),
  );
  sessionStorage.setItem(
    "chit-fleet-snapshot",
    JSON.stringify({
      campaign: "c1",
      state: "Active",
      budget: { funded: "20000000000000000", reserved: "0", spent: "21000000000000", unused: "19979000000000000" },
      accounts,
    }),
  );
};

for (const viewport of CONNECTED_VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  await context.addInitScript(seedConnected, { addr: ADDRESS, accounts: ACCOUNTS });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    failures.push(`connected @ ${viewport.name}: offsite request: ${route.request().method()} ${url}`);
    return route.abort();
  });
  for (const page of CONNECTED_PAGES) {
    const tab = await context.newPage();
    const errors = [];
    tab.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(`${BASE}${page}.html`, { waitUntil: "networkidle" });
    await tab.waitForTimeout(600);
    const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await tab.screenshot({ path: new URL(`${page}-${viewport.name}-connected.png`, OUT).pathname, fullPage: true });
    if (overflow > 0) failures.push(`${page} @ ${viewport.name} (connected): ${overflow}px of horizontal overflow`);
    for (const error of errors) failures.push(`${page} @ ${viewport.name} (connected): console error: ${error}`);
    await tab.close();
  }
  await context.close();
}

await browser.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  `ok: ${PAGES.length} pages x ${VIEWPORTS.length} viewports disconnected + ${CONNECTED_PAGES.length} pages x ${CONNECTED_VIEWPORTS.length} viewports connected passes, no overflow, no console errors, no off-site requests`,
);
