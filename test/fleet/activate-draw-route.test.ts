import assert from "node:assert/strict";
import test from "node:test";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { BalanceView, DrawSummary, PoolPort } from "../../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";
import type { FleetChain } from "../../src/fleet/chain-service.js";

/**
 * Activation in Stage 2 takes a draw from the balance instead of asking for a
 * transfer. Everything the pool would refuse must be refused here first, before
 * a fleet exists or a wallet is asked to do anything.
 */

const trader = privateKeyToAccount(`0x${"41".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const POOL = "0x0000000000000000000000000000000000000901" as Address;

const owner = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const accounts = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) }));

const policy = () => ({
  chainId: 46630,
  accounts: 5,
  router: "0x8876789976decbfcbbbe364623c63652db8c0904",
  function: "execute(bytes,bytes[],uint256)",
  maxTradeValue: "1000000000000000",
  perAccountGas: "200000000000000",
  totalGas: "1000000000000000",
  expiry: "2026-12-31T00:00:00.000Z",
});

const drawSummary = (over: Partial<DrawSummary> = {}): DrawSummary => ({
  amount: parseEther("0.02").toString(),
  spent: "0",
  remaining: parseEther("0.02").toString(),
  dueAt: "2026-09-07T12:05:00.000Z",
  state: "Pending",
  ...over,
});

const makeRouter = (over: { available?: string; paused?: boolean } = {}) => {
  const opened: { campaign: string; amount: string; depositor: string }[] = [];
  const service = new CampaignService(serviceConfig);
  const balance = (): BalanceView => ({
    available: over.available ?? parseEther("0.1").toString(),
    deposited: parseEther("0.1").toString(),
    spent: "0",
    openDraws: "0",
    headroom: { sizes: [], perTraderRemaining: "0", poolRemaining: "0" },
    exit: {},
    pool: { paused: over.paused ?? false },
    poolAddress: POOL,
  });
  const pool: PoolPort = {
    balance: async () => balance(),
    withdraw: async () => ({ payoutTx: `0x${"a".repeat(64)}`, queuedSpendTx: `0x${"b".repeat(64)}` }),
    openDraw: async ({ campaign, amount, depositor }) => {
      opened.push({ campaign, amount, depositor });
      return drawSummary({ amount, remaining: amount });
    },
    topUpDraw: async ({ amount }) => drawSummary({ amount, remaining: amount, state: "Funded" }),
    drawOf: async () => drawSummary(),
    ownerOf: async () => trader.address.toLowerCase() as Address,
    closeDraw: async () => drawSummary({ state: "Closed" }),
    sweep: async () => ({ funded: [], posted: [] }),
    buy: async () => ({ results: [], draw: drawSummary() }),
  };
  const chain: FleetChain = {
    registerCampaign: async () => undefined,
    readBudget: async () => ({ funded: "0", reserved: "0", spent: "0", unused: "0" }),
    activate: async () => [owner(11), owner(12), owner(13), owner(14), owner(15)],
    buy: async () => ({ results: [], budget: { funded: "0", reserved: "0", spent: "0", unused: "0" } }),
    loadCampaign: async () => undefined,
    isEnrolled: async () => true,
    accountsOf: async () => [],
    sessionOf: async () => undefined,
    control: async () => `0x${"c".repeat(64)}`,
  };
  const deps: RouterDeps = { service, pool, chain };
  return { router: new CampaignRouter(deps), service, opened };
};

const signed = async (service: CampaignService, action: string, body: Record<string, unknown>) => {
  const hash = payloadHash(body);
  const c = service.issueChallenge({ primaryWallet: trader.address, action, payloadHash: hash });
  const fields = {
    primaryWallet: trader.address, nonce: c.nonce, issuedAt: c.issuedAt,
    expiresAt: c.expiresAt, action, payloadHash: hash,
  };
  return {
    action,
    auth: {
      ...fields,
      signature: await trader.signMessage({ message: challengeBytes(serviceConfig, fields) }),
    } as AuthEnvelope,
    body,
  };
};

let counter = 0;
const key = () => `fleet-x${String(counter++).padStart(16, "0")}`;

const readyCampaign = async (router: CampaignRouter, service: CampaignService) => {
  const created = await router.handle(
    await signed(service, "create", {
      quoteId: "q", policy: policy(), accounts: accounts(5),
      recoveryVaultCommitment: `0x${"3".repeat(64)}`,
    }),
    key(),
  );
  const campaign = (created.body as { campaign: string }).campaign;
  await router.handle(await signed(service, "confirmRecovery", { campaign }), key());
  return campaign;
};

test("activation takes a draw from the balance and reports the wait", async () => {
  const { router, service, opened } = makeRouter();
  const campaign = await readyCampaign(router, service);
  const result = await router.handle(
    await signed(service, "activate", { campaign, draw: parseEther("0.02").toString() }),
    key(),
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { state: string; draw: DrawSummary };
  assert.equal(body.state, "Activating", "the trader is told the fleet is being funded");
  assert.equal(body.draw.amount, parseEther("0.02").toString());
  assert.equal(body.draw.state, "Pending");
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.depositor.toLowerCase(), trader.address.toLowerCase());
});

test("a draw larger than the balance is refused before anything is opened", async () => {
  const { router, service, opened } = makeRouter({ available: parseEther("0.01").toString() });
  const campaign = await readyCampaign(router, service);
  const result = await router.handle(
    await signed(service, "activate", { campaign, draw: parseEther("0.02").toString() }),
    key(),
  );
  assert.equal(result.status, 422);
  assert.equal((result.body as { code: string }).code, "budget_exceeded");
  assert.deepEqual(opened, []);
});

test("a draw over the per-campaign cap is refused", async () => {
  const { router, service, opened } = makeRouter({ available: parseEther("5").toString() });
  const campaign = await readyCampaign(router, service);
  const result = await router.handle(
    await signed(service, "activate", { campaign, draw: parseEther("0.3").toString() }),
    key(),
  );
  assert.equal(result.status, 422);
  assert.deepEqual(opened, [], "the cap is checked here, not learned from a revert");
});

test("a paused pool refuses activation and says which state is wrong", async () => {
  const { router, service, opened } = makeRouter({ paused: true });
  const campaign = await readyCampaign(router, service);
  const result = await router.handle(
    await signed(service, "activate", { campaign, draw: parseEther("0.02").toString() }),
    key(),
  );
  assert.equal(result.status, 409);
  assert.deepEqual(opened, []);
});

test("a missing or malformed draw is refused", async () => {
  for (const draw of [undefined, "0", "-5", "abc"]) {
    const { router, service } = makeRouter();
    const campaign = await readyCampaign(router, service);
    const result = await router.handle(
      await signed(service, "activate", { campaign, ...(draw === undefined ? {} : { draw }) }),
      key(),
    );
    assert.ok(result.status >= 400 && result.status < 500, `draw ${String(draw)} -> ${result.status}`);
  }
});

test("a top-up raises the draw of a campaign that ran out", async () => {
  const { router, service } = makeRouter();
  const campaign = await readyCampaign(router, service);
  await router.handle(await signed(service, "activate", { campaign, draw: parseEther("0.02").toString() }), key());
  const result = await router.handle(
    await signed(service, "topUp", { campaign, amount: parseEther("0.01").toString() }),
    key(),
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((result.body as { draw: DrawSummary }).draw.amount, parseEther("0.01").toString());
});

test("a top-up beyond the balance is refused", async () => {
  const { router, service } = makeRouter({ available: parseEther("0.005").toString() });
  const campaign = await readyCampaign(router, service);
  const result = await router.handle(
    await signed(service, "topUp", { campaign, amount: parseEther("0.01").toString() }),
    key(),
  );
  assert.equal(result.status, 422);
});
