import assert from "node:assert/strict";
import test from "node:test";
import { parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import type { FleetChain } from "../../src/fleet/chain-service.js";
import type { BalanceView, DrawSummary, PoolPort } from "../../src/fleet/pool-buy.js";
import type { AuthEnvelope } from "../../src/fleet/types.js";

/**
 * Closing a pooled campaign returns its unspent draw to the balance and moves
 * no ETH, so a trader can stop a fleet without publishing anything at all.
 */

const trader = privateKeyToAccount(`0x${"51".repeat(32)}`);
const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const POOL = "0x0000000000000000000000000000000000000901" as Address;

const owner = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;

const policy = () => ({
  chainId: 46630, accounts: 5,
  router: "0x8876789976decbfcbbbe364623c63652db8c0904",
  function: "execute(bytes,bytes[],uint256)",
  maxTradeValue: "1000000000000000",
  perAccountGas: "200000000000000",
  totalGas: "1000000000000000",
  expiry: "2026-12-31T00:00:00.000Z",
});

const makeRouter = () => {
  let draw: DrawSummary = {
    amount: parseEther("0.02").toString(),
    spent: parseEther("0.005").toString(),
    remaining: parseEther("0.015").toString(),
    dueAt: "2026-09-08T12:05:00.000Z",
    state: "Funded",
  };
  const closed: string[] = [];
  const service = new CampaignService(serviceConfig);
  const pool: PoolPort = {
    balance: async (): Promise<BalanceView> => ({
      available: parseEther("0.08").toString(),
      deposited: parseEther("0.1").toString(),
      spent: "0",
      openDraws: parseEther("0.02").toString(),
      headroom: { sizes: [], perTraderRemaining: "0", poolRemaining: "0" },
      exit: {},
      pool: { paused: false },
      poolAddress: POOL,
    }),
    withdraw: async () => ({ payoutTx: `0x${"a".repeat(64)}`, queuedSpendTx: `0x${"b".repeat(64)}` }),
    openDraw: async () => draw,
    topUpDraw: async ({ amount }) => {
      draw = { ...draw, amount, remaining: amount };
      return draw;
    },
    drawOf: async () => draw,
    closeDraw: async (campaign) => {
      closed.push(campaign);
      draw = { ...draw, state: "Closed" };
      return draw;
    },
    sweep: async () => ({ funded: [], posted: [] }),
    buy: async () => ({ results: [], draw }),
  };
  const chain: FleetChain = {
    registerCampaign: async () => undefined,
    readBudget: async () => ({ funded: "0", reserved: "0", spent: "0", unused: "0" }),
    activate: async () => [owner(11), owner(12), owner(13), owner(14), owner(15)],
    buy: async () => ({ results: [], budget: { funded: "0", reserved: "0", spent: "0", unused: "0" } }),
    loadCampaign: async () => undefined,
    isEnrolled: async () => true,
    accountsOf: async () => [],
    control: async () => `0x${"c".repeat(64)}`,
  };
  const deps: RouterDeps = { service, pool, chain };
  return { router: new CampaignRouter(deps), service, closed };
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
const key = () => `fleet-c${String(counter++).padStart(16, "0")}`;

const activeCampaign = async (router: CampaignRouter, service: CampaignService) => {
  const created = await router.handle(
    await signed(service, "create", {
      quoteId: "q", policy: policy(),
      accounts: Array.from({ length: 5 }, (_, i) => ({ ownerAddress: owner(i + 1), salt: salt(i + 1) })),
      recoveryVaultCommitment: `0x${"3".repeat(64)}`,
    }),
    key(),
  );
  const campaign = (created.body as { campaign: string }).campaign;
  await router.handle(await signed(service, "confirmRecovery", { campaign }), key());
  await router.handle(
    await signed(service, "activate", { campaign, draw: parseEther("0.02").toString() }),
    key(),
  );
  return campaign;
};

test("close reports what went back to the balance, not a payment", async () => {
  const { router, service, closed } = makeRouter();
  const campaign = await activeCampaign(router, service);
  const result = await router.handle(await signed(service, "close", { campaign }), key());
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { creditedToBalance?: string; returnedEth?: string; state: string };
  assert.equal(body.creditedToBalance, parseEther("0.015").toString());
  assert.equal(body.returnedEth, undefined, "no ETH is returned; it never left");
  assert.equal(body.state, "Closed");
  assert.equal(closed.length, 1);
});

test("a closed campaign sponsors nothing more", async () => {
  const { router, service } = makeRouter();
  const campaign = await activeCampaign(router, service);
  await router.handle(await signed(service, "close", { campaign }), key());
  const buy = await router.handle(
    await signed(service, "buy", {
      campaign, accounts: [owner(11)], token: "0x0000000000000000000000000000000000000001", value: "1",
    }),
    key(),
  );
  assert.equal(buy.status, 403);
});

test("pause and resume still work on a pooled campaign", async () => {
  const { router, service } = makeRouter();
  const campaign = await activeCampaign(router, service);
  const paused = await router.handle(await signed(service, "pause", { campaign }), key());
  assert.equal((paused.body as { state: string }).state, "Paused");
  const resumed = await router.handle(await signed(service, "resume", { campaign }), key());
  assert.equal((resumed.body as { state: string }).state, "Active");
});

test("the campaign result carries its draw so the dashboard can show it", async () => {
  const { router, service } = makeRouter();
  const campaign = await activeCampaign(router, service);
  const read = await router.handle(await signed(service, "read", { campaign }));
  const body = read.body as { draw?: DrawSummary };
  assert.equal(body.draw?.amount, parseEther("0.02").toString());
  assert.equal(body.draw?.remaining, parseEther("0.015").toString());
});
