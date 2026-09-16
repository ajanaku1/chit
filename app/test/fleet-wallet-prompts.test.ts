import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Every wallet prompt is a moment the trader has to act. Testing Chit end to
 * end turned up prompts nobody needed: a signed read every few seconds after a
 * deposit, a second one after every withdrawal, two for one token quote, and
 * one to look up wallets the page already knew. The ones that remain say what
 * they are for before the wallet opens.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (name: string): Promise<string> => readFile(join(appRoot, "src", name), "utf8");
const body = (text: string, head: RegExp): string => {
  const start = text.search(head);
  assert.ok(start >= 0, `no ${head} to inspect`);
  const end = text.indexOf("\n};", start);
  return text.slice(start, end < 0 ? undefined : end);
};

const bannerNode = { textContent: "", hidden: true, dataset: {} as Record<string, string>, offsetWidth: 0 };
Object.assign(globalThis, { document: { getElementById: (id: string) => (id === "status-banner" ? bannerNode : null) } });
const { banner, withWalletPrompt } = await import("../src/fleet/page-shared.js");

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("the page says what the wallet is asking while it asks, and takes it down after", async () => {
  const answer = deferred<string>();
  const asked = withWalletPrompt("Check your wallet: sign to show your fleets.", () => answer.promise);
  assert.equal(bannerNode.hidden, false);
  assert.equal(bannerNode.textContent, "Check your wallet: sign to show your fleets.");
  answer.resolve("0xsig");
  assert.equal(await asked, "0xsig");
  assert.equal(bannerNode.hidden, true);
});

test("a message the page set while the wallet was open is left alone", async () => {
  const answer = deferred<string>();
  const asked = withWalletPrompt("Check your wallet: sign to place this order.", () => answer.promise);
  banner("That order didn't go through.", "error");
  answer.resolve("0xsig");
  await asked;
  assert.equal(bannerNode.textContent, "That order didn't go through.");
  assert.equal(bannerNode.hidden, false);
});

test("overlapping prompts hand the line to the one still open, and a refusal still clears it", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const one = withWalletPrompt("first", () => first.promise);
  const two = withWalletPrompt("second", () => second.promise);
  second.resolve("0x2");
  await two;
  assert.equal(bannerNode.textContent, "first", "the prompt still open is what the trader is told about");
  first.reject(new Error("User rejected the request."));
  await assert.rejects(one, /User rejected/);
  assert.equal(bannerNode.hidden, true);
});

test("every signature and transaction the app asks for is explained first", async () => {
  for (const name of ["fleet/signed-request.ts", "fleet-page.ts", "balance-page.ts"]) {
    const text = await source(name);
    const asks = [...text.matchAll(/method: "(personal_sign|eth_sendTransaction)"/g)].length;
    const explained = [...text.matchAll(/withWalletPrompt\([\s\S]{0,200}?method: "(personal_sign|eth_sendTransaction)"/g)].length;
    assert.ok(asks > 0, `${name} no longer asks the wallet anything; update this test`);
    assert.equal(explained, asks, `${name} opens the wallet without saying why`);
  }
});

test("waiting for a deposit to land signs nothing; the balance is read once after", async () => {
  const text = await source("balance-page.ts");
  const settle = body(text, /const settle = /);
  const loop = settle.slice(settle.indexOf("for ("), settle.indexOf("\n  }\n"));
  assert.match(loop, /chainRecord\(\)/, "the wait does not watch the chain's public record");
  assert.doesNotMatch(loop, /load\(|readBalance\(|forceRefresh\(|signedFleetApi\(/, "the wait signs on every tick");
  assert.equal([...settle.matchAll(/load\(true\)/g)].length, 1, "a settled transaction is not read exactly once");
  assert.match(body(text, /const chainRecord = /), /method: "eth_call"/, "the chain record is not a plain read");
  for (const what of ["Deposit", "Exit request", "Claim"]) {
    assert.match(text, new RegExp(`poolAction\\("${what}"`), `${what} does not wait for the chain before reading`);
  }
});

test("a withdrawal shows the balance the service returned instead of signing for it again", async () => {
  const withdraw = body(await source("balance-page.ts"), /const withdraw = /);
  assert.match(withdraw, /rememberBalance\(wallet, result\["balance"\]/);
  assert.doesNotMatch(withdraw, /refresh\(|load\(|readBalance\(/, "a withdrawal still signs a second time to show the result");
});

test("the Trade page asks once per quote and never signs to look up wallets it already read", async () => {
  const text = await source("trade-page.ts");
  assert.match(text, /readSigned\(wallet, "tokenQuote", [^)]*\{ maxAgeMs: 60_000 \}\)/, "a quote asked twice signs twice");
  assert.doesNotMatch(text, /signedFleetApi\(wallet, "(holdings|tokenQuote|list)"/, "a read on the Trade page signs every time");
  const place = /async #place\([\s\S]*?\n  \}/.exec(text);
  assert.ok(place && /this\.#readHoldings\(wallet, fleet\)/.test(place[0]), "placing an order does not reuse the page's holdings read");
});

test("setup says up front that launching needs a balance, and never sends the trader away from it", async () => {
  const html = await readFile(join(appRoot, "fleet.html"), "utf8");
  assert.match(html, /id="balance-first"[^>]*hidden/, "nothing warns before anything is created");
  const wizard = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  for (const link of wizard.matchAll(/<a href="\.\/balance\.html"[^>]*>/g)) {
    assert.match(link[0], /target="_blank" rel="noopener"/, "a link to Balance replaces the page, and the setup in memory with it");
  }
  assert.match(html, /id="recheck-balance"/, "coming back from the Balance tab has no way to see the new balance");
  const page = await source("fleet-page.ts");
  assert.match(page, /el\("balance-first"\)\.hidden = available === undefined \|\| BigInt\(available\) > 0n/);
  assert.match(page, /el\("recheck-balance"\)\.addEventListener\("click"/);
});
