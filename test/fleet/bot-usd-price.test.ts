import assert from "node:assert/strict";
import { test } from "node:test";

import type { BotChain } from "../../src/fleet/bot-chain.js";
import { createUsdPrice } from "../../src/fleet/bot-usd-price.js";
import type { Address } from "../../src/fleet/types.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const readsAt = (perEth: bigint | null, calls: { n: number }) => ({
  async tokenInfo() { calls.n++; return perEth === null ? { symbol: "USDG", decimals: 6, hasPool: false, perEth: 0n } : { symbol: "USDG", decimals: 6, hasPool: true, perEth }; },
}) as unknown as Pick<BotChain, "tokenInfo">;

test("ETH's dollar price is the stablecoin pool's price, remembered for five minutes", async () => {
  const calls = { n: 0 };
  let t = 0;
  const price = createUsdPrice({ reads: readsAt(2_681_568_995n, calls), token: USDG, now: () => t });
  assert.equal(await price(), 2681.568995);
  t += 4 * 60_000;
  await price();
  assert.equal(calls.n, 1, "remembered");
  t += 2 * 60_000;
  await price();
  assert.equal(calls.n, 2, "read again after five minutes");
});

test("no pool, a failed read, or a price no one could believe is no price: the dollars button is simply not offered", async () => {
  assert.equal(await createUsdPrice({ reads: readsAt(null, { n: 0 }), token: USDG })(), undefined);
  assert.equal(await createUsdPrice({ reads: readsAt(50_000_000n, { n: 0 }), token: USDG })(), undefined, "$50 an ETH");
  assert.equal(await createUsdPrice({ reads: readsAt(500_000_000_000n, { n: 0 }), token: USDG })(), undefined, "$500 000 an ETH");
  const broken = { async tokenInfo() { throw new Error("rpc down"); } } as unknown as Pick<BotChain, "tokenInfo">;
  assert.equal(await createUsdPrice({ reads: broken, token: USDG })(), undefined);
});

test("taps that arrive while the price is being read wait on the same read", async () => {
  let release: (v: unknown) => void = () => undefined;
  const calls = { n: 0 };
  const slow = { async tokenInfo() { calls.n++; await new Promise((r) => { release = r; }); return { symbol: "USDG", decimals: 6, hasPool: true, perEth: 2_000_000_000n }; } } as unknown as Pick<BotChain, "tokenInfo">;
  const price = createUsdPrice({ reads: slow, token: USDG });
  const [a, b] = [price(), price()];
  release(undefined);
  assert.deepEqual(await Promise.all([a, b]), [2000, 2000]);
  assert.equal(calls.n, 1);
});
