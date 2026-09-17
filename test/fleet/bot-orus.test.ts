import assert from "node:assert/strict";
import test from "node:test";

import { createOrusScanner, orusLine, readScan } from "../../src/fleet/bot-orus.js";
import type { Address } from "../../src/fleet/types.js";

const TOKEN = "0xd523a627030509021cc39b6d7c8543417d3e50d8" as Address;

/** Orus's answer for CHIT on 17 September, trimmed to the fields the card reads; honeypot and taxes came back null. */
const chitAnswer = {
  apiVersion: "1.0",
  chainId: 4663,
  checkedAt: "2026-09-17T18:29:32.000Z",
  token: { address: TOKEN, name: "chit", symbol: "CHIT", decimals: 18 },
  market: { priceUsd: 0.00024, marketCapUsd: 236776.6, liquidityUsd: 22489.3 },
  security: { isHoneypot: null, buyTaxPct: null, sellTaxPct: null, liquidityBurnPct: 99.886 },
  risk: { bundlersPct: 29.086, snipersPct: 0, top10Pct: 25.42, holdersCount: 502 },
  deployer: { address: "0x96cb…", launches: 11, rugs: null },
  warnings: ["security_data_incomplete"],
};

const fetchAnswering = (status: number, body: unknown, calls: string[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer orus_pk_test");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

test("the line says what Orus knows and calls the rest unknown, never safe", () => {
  const scan = readScan(chitAnswer);
  assert.ok(scan);
  assert.equal(scan.honeypot, null);
  assert.equal(scan.holders, 502);
  const line = orusLine(scan, "https://www.orusagent.xyz/token/4663/" + TOKEN);
  assert.equal(line, `honeypot unknown · bundled 29% · top 10 hold 25% · 502 holders · liq $22k, burned · deployer 11 launches · <a href="https://www.orusagent.xyz/token/4663/${TOKEN}">checked by orus</a>`);
  assert.doesNotMatch(line, /safe/);
});

test("a known honeypot and known taxes are said plainly", () => {
  const scan = readScan({ ...chitAnswer, security: { isHoneypot: true, buyTaxPct: 5, sellTaxPct: 25, liquidityBurnPct: 0 } });
  assert.ok(scan);
  const line = orusLine(scan, "https://www.orusagent.xyz");
  assert.match(line, /^⚠️ honeypot · tax 5\/25 · /);
  assert.doesNotMatch(line, /burned/);
});

test("the scanner asks chain and token, keeps the answer a minute, and forgets it after", async () => {
  const calls: string[] = [];
  let clock = 1_000_000;
  const scanner = createOrusScanner({ apiKey: "orus_pk_test", chainId: 4663, fetch: fetchAnswering(200, chitAnswer, calls), now: () => clock });
  const first = await scanner.scan(TOKEN);
  assert.equal(first?.symbol, "CHIT");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /\/api\/v1\/scan\?chainId=4663&token=0xd523a627030509021cc39b6d7c8543417d3e50d8&include=none$/);
  await scanner.scan(TOKEN);
  assert.equal(calls.length, 1, "a second draw inside the minute is served from memory");
  clock += 61_000;
  await scanner.scan(TOKEN);
  assert.equal(calls.length, 2, "after the minute Orus is asked again");
});

test("off Robinhood Chain mainnet the scanner never asks: Orus scans 4663 only", async () => {
  const calls: string[] = [];
  const scanner = createOrusScanner({ apiKey: "orus_pk_test", chainId: 46630, fetch: fetchAnswering(400, { error: { code: "invalid_request" } }, calls) });
  assert.equal(await scanner.scan(TOKEN), undefined);
  assert.equal(calls.length, 0);
});

test("a token Orus has not indexed draws no line, and is not asked again for a minute", async () => {
  const calls: string[] = [];
  const scanner = createOrusScanner({ apiKey: "orus_pk_test", chainId: 4663, fetch: fetchAnswering(404, { error: { code: "token_not_found" } }, calls) });
  assert.equal(await scanner.scan(TOKEN), undefined);
  assert.equal(await scanner.scan(TOKEN), undefined);
  assert.equal(calls.length, 1);
});

test("a slow Orus is cut at the card's patience and the card draws without it", async () => {
  const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  const scanner = createOrusScanner({ apiKey: "orus_pk_test", chainId: 4663, fetch: slow, timeoutMs: 20 });
  const started = Date.now();
  assert.equal(await scanner.scan(TOKEN), undefined);
  assert.ok(Date.now() - started < 1_000);
});

test("a refused key or a quota is silence on the card, not a crash", async () => {
  for (const status of [401, 429, 503]) {
    const scanner = createOrusScanner({ apiKey: "orus_pk_test", chainId: 4663, fetch: fetchAnswering(status, { error: { code: "x" } }) });
    assert.equal(await scanner.scan(TOKEN), undefined);
  }
});
