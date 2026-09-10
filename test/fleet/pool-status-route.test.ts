import assert from "node:assert/strict";
import test from "node:test";
import { parseEther, type Address, type Hex } from "viem";

import { CampaignRouter, type RouterDeps } from "../../src/fleet/campaign-routes.js";
import { CampaignService } from "../../src/fleet/campaign-service.js";
import type { FleetChain } from "../../src/fleet/chain-service.js";
import type { BalanceView, DrawSummary, PoolPort } from "../../src/fleet/pool-buy.js";

/**
 * Watching a fleet be funded should not cost a wallet signature every few
 * seconds. `status` answers unsigned, and can afford to: everything it returns
 * is already readable on chain by anyone holding the campaign id, and it names
 * no depositor.
 */

const serviceConfig = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
const POOL = "0x0000000000000000000000000000000000000901" as Address;

const draw: DrawSummary = {
  amount: parseEther("0.02").toString(),
  spent: "0",
  remaining: parseEther("0.02").toString(),
  dueAt: "2026-09-10T20:30:00.000Z",
  state: "Pending",
};

const session = {
  chainId: 46630n,
  router: "0x8876789976decbfcbbbe364623c63652db8c0904" as Address,
  selector: "0x3593564c" as Hex,
  maxTradeValue: parseEther("0.001"),
  perAccountGas: parseEther("0.002"),
  totalGas: parseEther("0.01"),
  expiry: BigInt(Math.floor(Date.parse("2027-01-01T00:00:00Z") / 1000)),
  spentGas: 0n,
  paused: false,
  revoked: false,
};

const makeRouter = (over: { draw?: DrawSummary | undefined; hasSession?: boolean } = {}) => {
  const pool = {
    balance: async (): Promise<BalanceView> => ({
      available: "0", deposited: "0", spent: "0", openDraws: "0",
      headroom: { sizes: [], perTraderRemaining: "0", poolRemaining: "0" },
      exit: {}, pool: { paused: false }, poolAddress: POOL,
    }),
    drawOf: async () => ("draw" in over ? over.draw : draw),
    ownerOf: async () => "0x00000000000000000000000000000000000a11ce" as Address,
  } as unknown as PoolPort;
  const chain = {
    sessionOf: async () => ((over.hasSession ?? true) ? session : undefined),
  } as unknown as FleetChain;
  const deps: RouterDeps = { service: new CampaignService(serviceConfig), pool, chain };
  return new CampaignRouter(deps);
};

test("status answers without a signature while a fleet is being funded", async () => {
  const result = await makeRouter().handle({ action: "status", body: { campaign: "c-1" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body as { campaign: string; state: string; draw: DrawSummary };
  assert.equal(body.campaign, "c-1");
  assert.equal(body.state, "Activating", "a pending draw is a fleet still being funded");
  assert.equal(body.draw.dueAt, draw.dueAt);
});

test("status reports Active once the draw is funded", async () => {
  const funded = { ...draw, state: "Funded" as const };
  const result = await makeRouter({ draw: funded }).handle({ action: "status", body: { campaign: "c-1" } });
  assert.equal((result.body as { state: string }).state, "Active");
});

test("status never names a depositor", async () => {
  const result = await makeRouter().handle({ action: "status", body: { campaign: "c-1" } });
  const text = JSON.stringify(result.body).toLowerCase();
  assert.equal(text.includes("a11ce"), false, "the owner is the one thing this must not publish");
  assert.equal(text.includes("owner"), false);
});

test("status refuses a campaign the chain does not know", async () => {
  const result = await makeRouter({ draw: undefined, hasSession: false }).handle({
    action: "status",
    body: { campaign: "nope" },
  });
  assert.equal(result.status, 409);
});

test("status refuses a missing campaign id", async () => {
  const result = await makeRouter().handle({ action: "status", body: {} });
  assert.ok(result.status >= 400);
});
