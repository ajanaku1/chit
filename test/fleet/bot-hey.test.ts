import assert from "node:assert/strict";
import test from "node:test";

import { createHeyScanner, heyLine, readHey } from "../../src/fleet/bot-hey.js";
import type { Address } from "../../src/fleet/types.js";

const TOKEN = "0xd523a627030509021cc39b6d7c8543417d3e50d8" as Address;

/** HEY's answer for CHIT on 18 September, trimmed to what the card reads. */
const chitAnswer = {
  found: true,
  chainId: 4663,
  contractAddress: TOKEN,
  status: "shipping",
  status_label: "Shipping",
  verified_builder: true,
  activity: { commits_30d: 204, releases_30d: 1, ships_30d: 5, last_ship: "2026-09-17" },
  project: { slug: "chit", name: "Chit", symbol: "CHIT" },
  project_url: "https://heyresearch.xyz/project/chit",
  cta: { label: "See the builder on HEY", url: "https://heyresearch.xyz/project/chit" },
};

const fetchAnswering = (status: number, body: unknown, calls: { url: string; auth: string | undefined }[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

test("the line follows HEY's format: status, commits, releases, verified builder, the arrow", () => {
  const scan = readHey(chitAnswer);
  assert.ok(scan);
  assert.equal(heyLine(scan), `shipping · 204 commits · 1 release · verified builder · <a href="https://heyresearch.xyz/project/chit">see on HEY</a>`);
});

test("a missing field is skipped, it means unknown, never zero", () => {
  const scan = readHey({ ...chitAnswer, verified_builder: false, activity: { releases_30d: 0 } });
  assert.ok(scan);
  assert.equal(heyLine(scan), `shipping · 0 releases · <a href="https://heyresearch.xyz/project/chit">see on HEY</a>`);
});

test("found:false prints nothing, whatever else the body says", () => {
  assert.equal(readHey({ found: false, chainId: 4663, scan_url: "https://heyresearch.xyz/scan?address=0x" }), undefined);
  assert.equal(readHey({ found: false, reason: "chain", message: "HEY indexes Robinhood Chain (4663) only." }), undefined);
});

test("the scanner asks with the key when given one and anonymously otherwise, chain as HEY names it", async () => {
  const withKey: { url: string; auth: string | undefined }[] = [];
  const keyed = createHeyScanner({ chainId: 4663, apiKey: "hey_test", fetch: fetchAnswering(200, chitAnswer, withKey) });
  assert.equal((await keyed.scan(TOKEN))?.commits30d, 204);
  assert.equal(withKey[0]!.auth, "Bearer hey_test");
  assert.match(withKey[0]!.url, /\/api\/v1\/scan\?chain=4663&token=0xd523a627030509021cc39b6d7c8543417d3e50d8$/);
  const anon: { url: string; auth: string | undefined }[] = [];
  const open = createHeyScanner({ chainId: 4663, fetch: fetchAnswering(200, chitAnswer, anon) });
  await open.scan(TOKEN);
  assert.equal(anon[0]!.auth, undefined);
});

test("off Robinhood Chain mainnet the scanner never asks: HEY indexes 4663 only", async () => {
  const calls: { url: string; auth: string | undefined }[] = [];
  const scanner = createHeyScanner({ chainId: 46630, fetch: fetchAnswering(200, chitAnswer, calls) });
  assert.equal(await scanner.scan(TOKEN), undefined);
  assert.equal(calls.length, 0);
});

test("an answer or a miss is kept a minute per token", async () => {
  const calls: { url: string; auth: string | undefined }[] = [];
  let clock = 5_000_000;
  const scanner = createHeyScanner({ chainId: 4663, fetch: fetchAnswering(200, chitAnswer, calls), now: () => clock });
  await scanner.scan(TOKEN);
  await scanner.scan(TOKEN);
  assert.equal(calls.length, 1);
  clock += 61_000;
  await scanner.scan(TOKEN);
  assert.equal(calls.length, 2);
});

test("a bad key, a quota or a slow HEY is silence on the card, not a crash", async () => {
  for (const status of [401, 429, 503]) {
    const scanner = createHeyScanner({ chainId: 4663, fetch: fetchAnswering(status, { error: "x" }) });
    assert.equal(await scanner.scan(TOKEN), undefined);
  }
  const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  const scanner = createHeyScanner({ chainId: 4663, fetch: slow, timeoutMs: 20 });
  assert.equal(await scanner.scan(TOKEN), undefined);
});
