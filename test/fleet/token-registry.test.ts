import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { poolIdOf } from "../../src/fleet/pool-registry.js";
import { RegistryError, parseTokenRegistry } from "../../src/fleet/token-registry.js";

/** T063, T064: the registry loads and validates the reviewed list, and a poolId that is not its key's is a hard failure. */

const CHIT = "0xd523a627030509021cc39b6d7c8543417d3e50d8";
const entry = (over: Record<string, unknown> = {}) => ({
  token: CHIT, symbol: "CHIT", decimals: 18,
  poolKey: { currency0: `0x${"0".repeat(40)}`, currency1: CHIT, fee: 0, tickSpacing: 200, hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" },
  poolId: "0x84a4f18cfab0b389a63c4d8a56d08f021a6fd5efb0b0b3617cfbbd6706f09f41",
  slippageBps: 300, enabled: true,
  checks: { ordinaryTransfer: true, holderRestrictions: false, liquidityEth: "7000000000000000000", liquidityMultipleOfDrawCap: 140, forkTest: "x", checkedAt: "2026-09-16" },
  ...over,
});
const file = (tokens: unknown[]) => ({ chainId: 4663, poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951", router: "0x8876789976decbfcbbbe364623c63652db8c0904", tokens });

test("the committed mainnet registry loads, pins CHIT to the launchpad's pool, and offers only enabled entries", () => {
  const registry = parseTokenRegistry(JSON.parse(readFileSync("deployments/token-registry-4663.json", "utf8")), 4663);
  assert.equal(registry.chainId, 4663);
  const chit = registry.entry(CHIT.toUpperCase().replace("0X", "0x"))!;
  assert.equal(chit.poolId, poolIdOf(chit.poolKey), "the id is the key's");
  assert.equal(chit.poolKey.hooks, "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044");
  assert.deepEqual(registry.enabled().map((e) => e.symbol), ["CHIT"]);
  assert.equal(registry.entry(`0x${"1".repeat(40)}`), undefined, "an unlisted token is not an error; it is not listed");
});

test("a poolId that is not the id of its poolKey fails at load, hard (rule 1)", () => {
  assert.throws(() => parseTokenRegistry(file([entry({ poolId: `0x${"a".repeat(64)}` })]), 4663), (e: unknown) => e instanceof RegistryError && /not the id of its poolKey/.test(e.message));
  assert.throws(() => parseTokenRegistry(file([entry({ poolKey: { ...entry().poolKey, fee: 3000 } })]), 4663), /not the id of its poolKey/);
});

test("the file must be for the chain the service runs on, name each token once, and say enabled or not", () => {
  assert.throws(() => parseTokenRegistry(file([entry()]), 46630), /for chain 4663, the service runs on 46630/);
  assert.throws(() => parseTokenRegistry(file([entry(), entry()]), 4663), /listed twice/);
  assert.throws(() => parseTokenRegistry(file([entry({ enabled: "yes" })]), 4663), /neither enabled: true nor enabled: false/);
  assert.throws(() => parseTokenRegistry(file([entry({ poolKey: { ...entry().poolKey, currency1: `0x${"2".repeat(40)}` } })]), 4663), /not ETH against the token/);
});

test("a disabled entry is kept and never offered; an enabled one must carry its four checks with a date (FR-012)", () => {
  const disabled = parseTokenRegistry(file([entry({ enabled: false, checks: {} })]), 4663);
  assert.deepEqual(disabled.enabled(), []);
  assert.equal(disabled.entry(CHIT)?.enabled, false, "present, so listing it is a flag flip");
  assert.throws(() => parseTokenRegistry(file([entry({ checks: { ...entry().checks, ordinaryTransfer: false } })]), 4663), /checks do not pass/);
  assert.throws(() => parseTokenRegistry(file([entry({ checks: { ...entry().checks, liquidityMultipleOfDrawCap: 49 } })]), 4663), /checks do not pass/);
  assert.throws(() => parseTokenRegistry(file([entry({ checks: { ...entry().checks, checkedAt: "" } })]), 4663), /checks do not pass/);
  assert.equal(parseTokenRegistry(file([entry({ slippageBps: undefined })]), 4663).entry(CHIT)?.slippageBps, 100, "the bound defaults to 1% (rule 3)");
});
