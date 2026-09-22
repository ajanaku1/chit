import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData, parseAbi, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { OnChainSession } from "../../src/fleet/chain-campaign.js";
import type { FleetChain } from "../../src/fleet/chain-service.js";
import type { BalanceView, DrawSummary, PoolPort, PooledBuy } from "../../src/fleet/pool-buy.js";
import { poolIdOf } from "../../src/fleet/pool-registry.js";
import { anyEntry, readTokenRegistry } from "../../src/fleet/token-registry.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";
import { UNIVERSAL_ROUTER_EXECUTE } from "../../src/fleet/v4-swap.js";

/**
 * T065–T068: with a registry, a buy trades only a listed, enabled token,
 * through its pinned pool, within its own bound; the quote says the least the
 * depositor will receive; and a price that moved past the bound is refused
 * before anything is sent.
 */

const trader = privateKeyToAccount(`0x${"52".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 4663, maxTtlSeconds: 300 };
const CHIT = "0xd523a627030509021cc39b6d7c8543417d3e50d8" as Address;
const STOCK = `0x${"5".repeat(40)}` as Address;
const OTHER = `0x${"7".repeat(40)}` as Address;
const HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as Address;
const STOCK_KEY = { currency0: `0x${"0".repeat(40)}` as Address, currency1: STOCK, fee: 3000, tickSpacing: 60, hooks: `0x${"0".repeat(40)}` as Address };
const owner = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const policy = { chainId: 4663, accounts: 5, router: "0x8876789976decbfcbbbe364623c63652db8c0904", function: UNIVERSAL_ROUTER_EXECUTE, maxTradeValue: "1000000000000000", perAccountGas: "200000000000000", totalGas: "1000000000000000", expiry: "2026-12-31T00:00:00.000Z" };

const registry = readTokenRegistry({
  chainId: 4663,
  tokens: [
    { token: CHIT, symbol: "CHIT", decimals: 18, poolKey: { currency0: `0x${"0".repeat(40)}`, currency1: CHIT, fee: 0, tickSpacing: 200, hooks: HOOK }, poolId: "0x84a4f18cfab0b389a63c4d8a56d08f021a6fd5efb0b0b3617cfbbd6706f09f41", slippageBps: 300, enabled: true,
      checks: { ordinaryTransfer: true, holderRestrictions: false, liquidityEth: "7000000000000000000", liquidityMultipleOfDrawCap: 140, forkTest: "x", checkedAt: "2026-09-16" } },
    { token: STOCK, symbol: "STK", decimals: 18, poolKey: STOCK_KEY, poolId: poolIdOf(STOCK_KEY), enabled: false },
  ],
}, 4663);

const makeRouter = (initialQuote = "1000000") => {
  let quoteOut = initialQuote;
  const service = new CampaignService(serviceConfig);
  const draw: DrawSummary = { amount: parseEther("0.02").toString(), spent: "0", remaining: parseEther("0.02").toString(), dueAt: "2026-09-08T12:05:00.000Z", state: "Funded" };
  const bought: PooledBuy[] = [];
  const quoted: { token: Address; poolKey: unknown }[] = [];
  const pool: PoolPort = {
    balance: async (): Promise<BalanceView> => ({ available: parseEther("0.08").toString(), deposited: parseEther("0.1").toString(), spent: "0", openDraws: "0", headroom: { sizes: [], perTraderRemaining: "0", poolRemaining: "0" }, exit: {}, pool: { paused: false }, poolAddress: owner(0x901) }),
    withdraw: async () => ({ payoutTx: `0x${"a".repeat(64)}`, chargeId: "c" }),
    openDraw: async () => draw, topUpDraw: async () => draw, drawOf: async () => draw, ownerOf: async () => trader.address.toLowerCase() as Address, closeDraw: async () => draw,
    sweep: async () => ({ funded: [], posted: [] }),
    buy: async ({ buys }) => { bought.push(...buys); return { results: buys.map((b) => ({ account: b.account, status: "sponsored" as const })), draw }; },
  };
  const session = { chainId: 4663n, router: policy.router as Address, selector: "0x24856bc3", maxTradeValue: 10n ** 15n, perAccountGas: 2n * 10n ** 14n, totalGas: 10n ** 15n, expiry: 1_800_000_000n, spentGas: 0n, paused: false, revoked: false, exists: true } as OnChainSession;
  const chain = { registerCampaign: async () => undefined, readBudget: async () => ({ funded: "0", reserved: "0", spent: "0", unused: "0" }), activate: async () => [owner(11), owner(12), owner(13), owner(14), owner(15)], buy: async () => ({ results: [], budget: { funded: "0", reserved: "0", spent: "0", unused: "0" } }), loadCampaign: async () => undefined, isEnrolled: async () => true, accountsOf: async () => [owner(11), owner(12), owner(13), owner(14), owner(15)], sessionOf: async () => session, control: async () => `0x${"c".repeat(64)}` } as FleetChain;
  const market = {
    // The quote scales with the amount, as a pool's does: quoteOut is the fill for 0.001 ETH.
    tokenQuote: async (token: Address, amount: string, poolKey?: unknown) => { quoted.push({ token, poolKey }); return { token, symbol: "CHIT", decimals: 18, hasPool: true, sqrtPriceX96: "1", estimatedOut: ((BigInt(quoteOut) * BigInt(amount)) / 1_000_000_000_000_000n).toString() }; },
    holdings: async () => [], campaignsOf: async () => [],
  };
  const deps: RouterDeps = { service, pool, chain, market, registry, now: () => new Date("2026-09-22T12:10:00.000Z") };
  return { router: new CampaignRouter(deps), service, bought, quoted, setQuote: (out: string) => { quoteOut = out; } };
};
const signed = async (service: CampaignService, action: string, body: Record<string, unknown>) => {
  const hash = payloadHash(body);
  const c = service.issueChallenge({ primaryWallet: trader.address, action, payloadHash: hash });
  const fields = { primaryWallet: trader.address, nonce: c.nonce, issuedAt: c.issuedAt, expiresAt: c.expiresAt, action, payloadHash: hash };
  return { action, auth: { ...fields, signature: await trader.signMessage({ message: challengeBytes(serviceConfig, fields) }) } as AuthEnvelope, body };
};
let counter = 0;
const key = () => `fleet-r${String(counter++).padStart(16, "0")}`;
const activeCampaign = async (router: CampaignRouter, service: CampaignService) => {
  const created = await router.handle(await signed(service, "create", { quoteId: "q", policy, accounts: Array.from({ length: 5 }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) })), recoveryVaultCommitment: `0x${"3".repeat(64)}` }), key());
  const campaign = (created.body as { campaign: string }).campaign;
  await router.handle(await signed(service, "confirmRecovery", { campaign }), key());
  await router.handle(await signed(service, "activate", { campaign, draw: parseEther("0.02").toString() }), key());
  return campaign;
};
const buy = (campaign: string, token: Address, extra: Record<string, unknown> = {}) => ({ campaign, accounts: [owner(11)], token, value: "1000000000000000", ...extra });

test("with a registry, only a listed and enabled token trades; unlisted and disabled are refused before anything moves", async () => {
  const { router, service, bought } = makeRouter();
  const campaign = await activeCampaign(router, service);
  const unlisted = await router.handle(await signed(service, "buy", buy(campaign, OTHER)), key());
  assert.equal(unlisted.status, 403);
  assert.equal((unlisted.body as { reason?: string }).reason, "token_not_listed");
  const disabled = await router.handle(await signed(service, "buy", buy(campaign, STOCK)), key());
  assert.equal((disabled.body as { reason?: string }).reason, "token_disabled", "present but disabled: no path trades it (T072)");
  assert.deepEqual(bought, []);
});

test("a listed token is quoted and bought through its pinned pool, within its own bound", async () => {
  const { router, service, bought, quoted } = makeRouter("1000000");
  const campaign = await activeCampaign(router, service);
  const quote = await router.handle(await signed(service, "tokenQuote", { campaign, token: CHIT, totalWei: "1000000000000000" }), key());
  assert.equal(quote.status, 200);
  const q = quote.body as { boundBps: number; minOut: string; estimatedOut: string };
  assert.equal(q.boundBps, 300, "the registry's bound, not the operator's default");
  assert.equal(q.minOut, "970000", "the least the depositor will receive, as a figure (T068)");
  assert.deepEqual(quoted.at(-1)?.poolKey, anyEntry(registry, CHIT)!.poolKey, "quoted on the pinned pool");

  const result = await router.handle(await signed(service, "buy", buy(campaign, CHIT)), key());
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const call = decodeFunctionData({ abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]), data: bought[0]!.callData });
  const input = (call.args[1] as Hex[])[0]!.toLowerCase();
  assert.ok(input.includes(HOOK.slice(2).toLowerCase()), "the buy names the pinned pool's hook");
  assert.ok(input.includes((970000).toString(16).padStart(64, "0")), "and carries the bound as its minimum output");
});

test("a price that moved past the bound since the depositor accepted the quote is refused before any transaction is sent (T067)", async () => {
  const { router, service, bought } = makeRouter("960000");
  const campaign = await activeCampaign(router, service);
  const moved = await router.handle(await signed(service, "buy", buy(campaign, CHIT, { acceptedOut: "1000000" })), key());
  assert.equal(moved.status, 403);
  assert.equal((moved.body as { reason?: string }).reason, "price_moved");
  assert.deepEqual(bought, [], "nothing was sent, so nothing was spent");
  const still = await router.handle(await signed(service, "buy", buy(campaign, CHIT, { acceptedOut: "980000" })), key());
  assert.equal(still.status, 200, "inside the bound the buy goes ahead");
  assert.equal(bought.length, 1);
});

test("the picker's list is the registry's enabled entries and nothing else; a disabled token's holdings stay visible (T071, T072, T076)", async () => {
  const { router } = makeRouter();
  const listed = await router.handle({ action: "tokens", body: {} });
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.body as { tokens: { symbol: string; boundBps: number }[] }).tokens, [{ token: CHIT, symbol: "CHIT", decimals: 18, boundBps: 300 }], "STK, disabled, is not offered");
});

test("an order keeps the fill accepted at placement, and a slice whose share the pool no longer gives inside the bound is refused before it is sent, alone", async () => {
  const { router, service, bought, setQuote } = makeRouter("1000000");
  const campaign = await activeCampaign(router, service);
  const placed = await router.handle(await signed(service, "order", { campaign, token: CHIT, totalWei: "1000000000000000", wallets: [owner(11), owner(12)], entropy: `0x${"9".repeat(64)}`, createdAt: "2026-09-22T12:00:00.000Z", windowMs: 60_000 }), key());
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const order = (placed.body as { order: Record<string, unknown> }).order;
  assert.equal(order["acceptedOut"], "1000000", "the fill quoted at placement rides with the order");
  const slices = (placed.body as { slices: { index: number; dueAt: string }[] }).slices;

  setQuote("960000");
  const run = await router.handle(await signed(service, "trade", { campaign, order, pending: slices.map((s) => s.index) }), key());
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const executed = (run.body as { executed: { status: string; reason?: string }[] }).executed;
  assert.ok(executed.length > 0, "at least one slice was due");
  assert.ok(executed.every((e) => e.status === "rejected" && e.reason === "price_moved"), JSON.stringify(executed));
  assert.deepEqual(bought, [], "nothing was sent for a price past the bound");
});
