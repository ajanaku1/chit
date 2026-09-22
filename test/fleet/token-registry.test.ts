import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseEther } from "viem";

import { anyEntry, enabledTokens, leastOut, loadTokenRegistry, meetsLiquidity, readTokenRegistry, tradableEntry } from "../../src/fleet/token-registry.js";
import type { Address } from "../../src/fleet/types.js";

const CHIT = "0xd523a627030509021cc39b6d7c8543417d3e50d8" as Address;
const NATIVE = "0x0000000000000000000000000000000000000000";
const HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const POOL_ID = "0x84a4f18cfab0b389a63c4d8a56d08f021a6fd5efb0b0b3617cfbbd6706f09f41";

const checks = { ordinaryTransfer: true, holderRestrictions: false, liquidityEth: "9.023", liquidityMultipleOfDrawCap: 180, forkTest: "passed", checkedAt: "2026-09-22T10:41:00.000Z" };
const chit = { token: CHIT, symbol: "CHIT", decimals: 18, poolKey: { currency0: NATIVE, currency1: CHIT, fee: 0, tickSpacing: 200, hooks: HOOK }, poolId: POOL_ID, slippageBps: 300, enabled: true, checks };
const doc = (...tokens: unknown[]) => ({ chainId: 4663, tokens });

test("the committed registry reads, and CHIT's entry is the buyback's pool with the bound the fork measured", async () => {
  const file = JSON.parse(await readFile(path.resolve("deployments/token-registry-4663.json"), "utf8"));
  const registry = readTokenRegistry(file, 4663);
  const entry = tradableEntry(registry, CHIT);
  assert.ok(entry);
  assert.equal(entry.poolId, POOL_ID, "the pool the buyback buys through, deployments/buyback-4663.json");
  assert.equal(entry.poolKey.hooks, HOOK.toLowerCase());
  assert.equal(entry.slippageBps, 300, "a hooked pool records the bound measured on a fork");
  assert.ok(entry.checks && entry.checks.liquidityMultipleOfDrawCap >= 50);
});

test("rule 1: a poolId that is not the id of its poolKey is a hard failure naming the token", () => {
  assert.throws(() => readTokenRegistry(doc({ ...chit, poolKey: { ...chit.poolKey, fee: 3000 } })), /CHIT: poolId 0x84a4.* is not the id of poolKey/);
  assert.throws(() => readTokenRegistry(doc({ ...chit, poolId: `0x${"1".repeat(64)}` })), /CHIT: poolId/);
});

test("rule 2: the pinned pool is the token's ETH pool, or the entry is refused", () => {
  assert.throws(() => readTokenRegistry(doc({ ...chit, poolKey: { ...chit.poolKey, currency0: "0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f" } })), /currency0 is native ETH/);
  assert.throws(() => readTokenRegistry(doc({ ...chit, token: "0x89baf66f3c98b07cef3d4f9e91da5956aca6252d" })), /is not the token/);
});

test("rule 3: the bound defaults to 100 bps and must be a sane integer", () => {
  const { slippageBps, ...noBound } = chit;
  void slippageBps;
  assert.equal(readTokenRegistry(doc(noBound)).tokens[0]!.slippageBps, 100);
  assert.throws(() => readTokenRegistry(doc({ ...chit, slippageBps: 0 })), /slippageBps/);
  assert.throws(() => readTokenRegistry(doc({ ...chit, slippageBps: 12.5 })), /slippageBps/);
});

test("rule 4 and FR-038: a disabled entry is never offered and no buy path finds it, but what a fleet holds of it stays on record", () => {
  const registry = readTokenRegistry(doc({ ...chit, enabled: false, checks: undefined, note: "off" }));
  assert.deepEqual(enabledTokens(registry), []);
  assert.equal(tradableEntry(registry, CHIT), undefined);
  assert.equal(anyEntry(registry, CHIT)?.note, "off", "the entry is kept, so the holding can be moved");
  assert.equal(tradableEntry(registry, CHIT.toUpperCase() as Address), undefined, "case never lets it through");
});

test("an entry is enabled only with its four checks on file and passed; enabled must be said, never assumed", () => {
  const { enabled, ...noFlag } = chit;
  void enabled;
  assert.throws(() => readTokenRegistry(doc(noFlag)), /enabled must be true or false/);
  assert.throws(() => readTokenRegistry(doc({ ...chit, checks: undefined })), /enabled without its checks/);
  assert.throws(() => readTokenRegistry(doc({ ...chit, checks: { ...checks, ordinaryTransfer: false } })), /transfer check failed/);
  assert.throws(() => readTokenRegistry(doc({ ...chit, checks: { ...checks, holderRestrictions: true } })), /restricts holders/);
  assert.throws(() => readTokenRegistry(doc({ ...chit, checks: { ...checks, liquidityMultipleOfDrawCap: 49 } })), /49× the draw cap, under 50/);
  assert.throws(() => readTokenRegistry(doc({ ...chit, checks: { ...checks, checkedAt: "soon" } })), /not a date/);
});

test("a token listed twice, a file for another chain, and a malformed file are refused with the reason", () => {
  assert.throws(() => readTokenRegistry(doc(chit, chit)), /listed twice/);
  assert.throws(() => readTokenRegistry(doc(chit), 46630), /the file is for 4663, this runtime is on 46630/);
  assert.throws(() => readTokenRegistry({ chainId: 4663, tokens: "CHIT" }), /tokens: not a list/);
  assert.throws(() => readTokenRegistry("nope"), /not an object/);
});

test("the live liquidity check and the least a depositor receives", () => {
  const drawCap = parseEther("0.05");
  assert.equal(meetsLiquidity(parseEther("2.5"), drawCap), true, "fifty times the draw cap, exactly, passes");
  assert.equal(meetsLiquidity(parseEther("2.499"), drawCap), false);
  assert.equal(leastOut(1_000_000n, 300), 970_000n);
  assert.equal(leastOut(1_000_000n, 100), 990_000n);
});

test("loading: a missing file is an empty registry, a broken one is refused, a good one reads", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await loadTokenRegistry(4663, dir), { chainId: 4663, tokens: [] });
  await writeFile(path.join(dir, "token-registry-4663.json"), "{ not json");
  await assert.rejects(loadTokenRegistry(4663, dir), /not JSON/);
  await writeFile(path.join(dir, "token-registry-4663.json"), JSON.stringify(doc(chit)));
  assert.equal((await loadTokenRegistry(4663, dir)).tokens[0]!.symbol, "CHIT");
});
