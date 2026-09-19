import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData, keccak256, parseAbi, recoverMessageAddress, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CampaignService, challengeBytes, payloadHash } from "../../src/fleet/campaign-service.js";
import { sponsorshipDigest } from "../../src/fleet/paymaster-data.js";
import type { SponsorChain } from "../../src/fleet/sponsor-chain.js";
import { chargedWithFee, checkSponsorship, decodeSponsoredCall, parseSponsorPolicy } from "../../src/fleet/sponsor-policy.js";
import { SponsorRouter } from "../../src/fleet/sponsor-routes.js";
import { SponsorService, decodePaymasterAndData, reservationKey, userHashOf } from "../../src/fleet/sponsor-service.js";
import { MemorySponsorStore } from "../../src/fleet/sponsor-store.js";
import { requiredPrefund } from "../../src/fleet/sponsored-op.js";
import { encodeExecuteCall } from "../../src/fleet/user-operation.js";
import type { Address, AuthEnvelope } from "../../src/fleet/types.js";

/**
 * The gas-sponsorship service against a chain that fits in a Map: a budget
 * per sponsor, a paymaster deposit, an operator key that signs. Every FR-002
 * check, the caps across "instances" (two services over one store), the
 * signature a dapp gets back, and what the dashboard shows and hides.
 */

const operator = privateKeyToAccount(`0x${"33".repeat(32)}`);
const dapp = privateKeyToAccount(`0x${"44".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"55".repeat(32)}`);
const PAYMASTER = "0x00000000000000000000000000000000000000aa" as Address;
const ESCROW = "0x00000000000000000000000000000000000000ee" as Address;
const ENTRY = "0x0000000071727de22e5e9d8baf0edac6f37da032" as Address;
const GAME = "0x0000000000000000000000000000000000000001" as Address;
const OTHER = "0x0000000000000000000000000000000000000002" as Address;
const USER = "0x00000000000000000000000000000000000000f1" as Address;
const PROBE_ABI = parseAbi(["function ping(bytes32 note)", "function pong()"]);
const PING = "0x" + keccak256(stringToHex("ping(bytes32)")).slice(2, 10);

const config = { origin: "https://chit.example", chainId: 46630, maxTtlSeconds: 300 };
let clock = new Date("2026-09-15T10:00:00.000Z");
const now = () => clock;

/** A chain of maps. Budgets fund from a method the test calls, as the sponsor's wallet would. */
const fakeChain = (feeBps = 2000) => {
  const budgets = new Map<Hex, { funded: bigint; reserved: bigint; spent: bigint }>();
  const committed = new Map<string, bigint>();
  const registered: Array<{ id: Hex; owner: Address }> = [];
  const submitted: unknown[] = [];
  let deposit = 10n ** 17n;
  const chain: SponsorChain & { fund: (id: Hex, wei: bigint) => void; registered: typeof registered; submitted: typeof submitted; settle: (id: Hex, key: Hex, charged: bigint) => void } = {
    chainId: 46630, entryPoint: ENTRY, paymaster: PAYMASTER, escrow: ESCROW, operator: operator.address,
    registered, submitted,
    feeBps: async () => feeBps,
    async registerSponsor(id, owner) { registered.push({ id, owner }); budgets.set(id, { funded: 0n, reserved: 0n, spent: 0n }); return `0x${"01".repeat(32)}`; },
    async budgetOf(id) { const b = budgets.get(id) ?? { funded: 0n, reserved: 0n, spent: 0n }; return { ...b, unused: b.funded - b.spent - b.reserved }; },
    async committedOf(id, key) { return committed.get(`${id}:${key}`) ?? 0n; },
    paymasterDeposit: async () => deposit,
    signSponsorship: (digest) => operator.signMessage({ message: { raw: digest } }),
    userOpHash: async () => `0x${"ab".repeat(32)}`,
    baseFee: async () => 10_000_000n,
    async submit(op) { submitted.push(op); deposit -= 1000n; return { txHash: `0x${"cc".repeat(32)}`, userOpHash: `0x${"ab".repeat(32)}`, success: true, actualGasCost: 1000n, actualGasUsed: 100n }; },
    fund: (id, wei) => { const b = budgets.get(id)!; b.funded += wei; },
    settle: (id, key, charged) => { const b = budgets.get(id)!; b.spent += charged; committed.set(`${id}:${key}`, charged); },
  };
  return chain;
};

const policy = () => ({
  targets: [{ address: GAME, selectors: [PING] }],
  maxCostPerOp: (10n ** 15n).toString(),          // 0.001 ETH per op
  maxPerUserPerDay: (3n * 10n ** 15n).toString(),  // three ops a day per user
  maxPerSponsorPerDay: (10n ** 16n).toString(),    // ten a day in all
});

const opFor = (sender: Address, nonce: bigint, callData: Hex) => ({
  sender, nonce: nonce.toString(), initCode: "0x", callData,
  callGasLimit: "150000", verificationGasLimit: "600000", preVerificationGas: "60000",
  maxFeePerGas: "40000000", maxPriorityFeePerGas: "0",
});
const ping = (note = "x") => encodeExecuteCall(GAME, "0", encodeFunctionData({ abi: PROBE_ABI, functionName: "ping", args: [keccak256(stringToHex(note))] }));

const setup = (chain = fakeChain()) => {
  const store = new MemorySponsorStore();
  const auth = new CampaignService(config, { now });
  const service = new SponsorService({ store, chain, now, randomId: () => `0x${"5e".repeat(32)}` });
  const router = new SponsorRouter({ auth, service });
  const signed = async (action: string, body: Record<string, unknown>, as = dapp) => {
    const hash = payloadHash(body);
    const challenge = auth.issueChallenge({ primaryWallet: as.address, action, payloadHash: hash });
    const fields = { primaryWallet: as.address, nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, action, payloadHash: hash };
    const envelope: AuthEnvelope = { ...fields, signature: await as.signMessage({ message: challengeBytes(config, fields) }) };
    return router.handle({ action, body, auth: envelope });
  };
  const open = (action: string, body: Record<string, unknown>) => router.handle({ action, body });
  return { store, chain, service, router, signed, open };
};

test("policy: parsed strictly, and every refusal has a name", () => {
  const p = parseSponsorPolicy(policy());
  assert.equal(p.targets[0]?.address, GAME);
  assert.throws(() => parseSponsorPolicy({ ...policy(), targets: [] }), /targets_required/);
  assert.throws(() => parseSponsorPolicy({ ...policy(), maxCostPerOp: "0" }), /invalid_maxCostPerOp/);
  assert.throws(() => parseSponsorPolicy({ ...policy(), maxPerUserPerDay: "1" }), /op_ceiling_over_user_cap/);
  assert.throws(() => parseSponsorPolicy({ ...policy(), targets: [{ address: GAME, selectors: ["0x12"] }] }), /invalid_selector/);

  const call = decodeSponsoredCall(ping());
  assert.deepEqual(call, { target: GAME, value: 0n, selector: PING });
  assert.equal(decodeSponsoredCall("0xdeadbeef"), null, "not an execute");
  const facts = { maxCharged: 10n ** 14n, userSpentToday: 0n, sponsorSpentToday: 0n, budgetUnused: 10n ** 18n };
  assert.equal(checkSponsorship(p, call, facts), null);
  assert.equal(checkSponsorship(p, null, facts), "call_not_execute");
  assert.equal(checkSponsorship(p, { ...call!, value: 1n }, facts), "value_not_zero");
  assert.equal(checkSponsorship(p, { ...call!, target: OTHER }, facts), "target_not_allowed");
  assert.equal(checkSponsorship(p, { ...call!, selector: "0x00000000" }, facts), "selector_not_allowed");
  assert.equal(checkSponsorship(p, call, { ...facts, maxCharged: 10n ** 16n }), "cost_over_ceiling");
  assert.equal(checkSponsorship(p, call, { ...facts, userSpentToday: 3n * 10n ** 15n }), "user_daily_cap");
  assert.equal(checkSponsorship(p, call, { ...facts, sponsorSpentToday: 10n ** 16n }), "sponsor_daily_cap");
  assert.equal(checkSponsorship(p, call, { ...facts, budgetUnused: 1n }), "budget_short");
  const anyFn = parseSponsorPolicy({ ...policy(), targets: [{ address: GAME, selectors: [] }] });
  assert.equal(checkSponsorship(anyFn, { ...call!, selector: "0x00000000" }, facts), null, "no selectors means any function");
});

test("a sponsor registers by signature, funds, and its users get sponsored without a login", async () => {
  const { chain, signed, open, store } = setup();
  const r = await signed("register", { policy: policy() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { sponsor, escrow } = r.body as { sponsor: Hex; escrow: Address };
  assert.equal(escrow, ESCROW);
  assert.deepEqual(chain.registered, [{ id: sponsor, owner: dapp.address.toLowerCase() }]);
  chain.fund(sponsor, 10n ** 16n);

  const s = await open("sponsor", { sponsor, op: opFor(USER, 0n, ping()) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const body = s.body as { paymasterAndData: Hex; key: Hex; maxCost: string; maxCharged: string; validUntil: number; feeBps: number };
  assert.equal(body.feeBps, 2000);
  assert.equal(body.key, reservationKey(sponsor, USER, 0n));
  const prefund = requiredPrefund({ verificationGasLimit: 600000n, callGasLimit: 150000n, preVerificationGas: 60000n, paymasterVerificationGas: 200000n, paymasterPostOpGas: 100000n, maxFeePerGas: 40000000n, maxPriorityFeePerGas: 0n });
  assert.equal(body.maxCost, prefund.toString());
  assert.equal(body.maxCharged, (prefund + prefund / 5n).toString(), "the charge is the prefund plus 20%");
  assert.equal(body.validUntil, Math.floor(clock.getTime() / 1000) + 600, "ten minutes, not more");

  // The signature the dapp gets back is the operator's, over exactly these fields.
  const pm = decodePaymasterAndData(body.paymasterAndData)!;
  assert.equal(pm.paymaster, PAYMASTER);
  assert.equal(pm.campaign, sponsor);
  assert.equal(pm.key, body.key);
  const digest = sponsorshipDigest({
    paymaster: PAYMASTER, campaign: sponsor, key: body.key, maxCost: prefund, chainId: 46630, validUntil: body.validUntil,
    operation: {
      sender: USER, nonce: 0n, callData: ping(),
      accountGasLimits: `0x${(600000n).toString(16).padStart(32, "0")}${(150000n).toString(16).padStart(32, "0")}`,
      preVerificationGas: 60000n,
      gasFees: `0x${"0".repeat(32)}${(40000000n).toString(16).padStart(32, "0")}`,
    },
  });
  assert.equal(await recoverMessageAddress({ message: { raw: digest }, signature: pm.signature }), operator.address);

  // Recorded, by user hash, never by address.
  const [recorded] = await store.listOps(sponsor, 10);
  assert.equal(recorded?.userHash, userHashOf(USER, sponsor));
  assert.equal(recorded?.target, GAME);
  assert.equal(recorded?.maxCharged, body.maxCharged);

  // The same op twice is refused: one reservation key per (sender, nonce).
  const again = await open("sponsor", { sponsor, op: opFor(USER, 0n, ping()) });
  assert.equal(again.status, 409);
});

test("every refusal happens before a signature, with its reason", async () => {
  const { chain, signed, open, store } = setup();
  const { sponsor } = (await signed("register", { policy: policy() })).body as { sponsor: Hex };

  const refused = async (body: Record<string, unknown>, reason: string, status = 422) => {
    const r = await open("sponsor", body);
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal((r.body as { reason: string }).reason, reason);
  };
  await refused({ sponsor, op: opFor(USER, 0n, ping()) }, "budget_short");
  chain.fund(sponsor, 10n ** 16n);
  await refused({ sponsor: `0x${"99".repeat(32)}`, op: opFor(USER, 0n, ping()) }, "sponsor_unknown");
  await refused({ sponsor, op: opFor(USER, 0n, encodeExecuteCall(OTHER, "0", "0x12345678")) }, "target_not_allowed");
  await refused({ sponsor, op: opFor(USER, 0n, encodeExecuteCall(GAME, "0", encodeFunctionData({ abi: PROBE_ABI, functionName: "pong" }))) }, "selector_not_allowed");
  await refused({ sponsor, op: opFor(USER, 0n, encodeExecuteCall(GAME, "1", "0x12345678")) }, "value_not_zero");
  await refused({ sponsor, op: opFor(USER, 0n, "0xdeadbeef") }, "call_not_execute");
  await refused({ sponsor, op: { ...opFor(USER, 0n, ping()), callGasLimit: "30000000" } }, "cost_over_ceiling");
  await refused({ sponsor, op: { ...opFor(USER, 0n, ping()), callGasLimit: "x" } }, "invalid_callGasLimit", 400);
  assert.equal((await store.listOps(sponsor, 10)).length, 0, "nothing recorded for a refusal");

  await signed("pause", { sponsor });
  await refused({ sponsor, op: opFor(USER, 0n, ping()) }, "sponsor_paused");
  await signed("resume", { sponsor });
  assert.equal((await open("sponsor", { sponsor, op: opFor(USER, 0n, ping()) })).status, 200);
  await signed("close", { sponsor });
  await refused({ sponsor, op: opFor(USER, 1n, ping()) }, "sponsor_closed");
});

test("daily caps hold across two service instances over one store, and reset with the UTC day", async () => {
  const chain = fakeChain();
  const store = new MemorySponsorStore();
  const a = new SponsorService({ store, chain, now, randomId: () => `0x${"5e".repeat(32)}` });
  const b = new SponsorService({ store, chain, now });
  // The policy is cut to the op's own ceiling: three a day per user, four a day in all.
  const ceiling = chargedWithFee(requiredPrefund({ verificationGasLimit: 600000n, callGasLimit: 150000n, preVerificationGas: 60000n, paymasterVerificationGas: 200000n, paymasterPostOpGas: 100000n, maxFeePerGas: 40000000n, maxPriorityFeePerGas: 0n }), 2000);
  const { sponsor } = await a.register(dapp.address, { ...policy(), maxCostPerOp: ceiling.toString(), maxPerUserPerDay: (ceiling * 3n).toString(), maxPerSponsorPerDay: (ceiling * 4n).toString() });
  chain.fund(sponsor, 10n ** 18n);

  assert.equal((await a.sponsor(sponsor, opFor(USER, 0n, ping()))).maxCharged, ceiling.toString());
  await b.sponsor(sponsor, opFor(USER, 1n, ping()));
  await a.sponsor(sponsor, opFor(USER, 2n, ping()));
  await assert.rejects(b.sponsor(sponsor, opFor(USER, 3n, ping())), /user_daily_cap/, "the other instance sees the first one's signatures");
  // Another user is still fine once; then the sponsor's own day runs out.
  const other = "0x00000000000000000000000000000000000000f2" as Address;
  await b.sponsor(sponsor, opFor(other, 0n, ping()));
  await assert.rejects(a.sponsor(sponsor, opFor(other, 1n, ping())), /sponsor_daily_cap/);

  clock = new Date("2026-09-16T00:00:01.000Z");
  const next = await a.sponsor(sponsor, opFor(USER, 3n, ping()));
  assert.ok(next.paymasterAndData, "a new UTC day, a new cap");
  clock = new Date("2026-09-15T10:00:00.000Z");
});

test("submit bundles only what the service signed, once, and records what the escrow charged", async () => {
  const { chain, signed, open, store } = setup();
  const { sponsor } = (await signed("register", { policy: policy() })).body as { sponsor: Hex };
  chain.fund(sponsor, 10n ** 16n);
  const s = (await open("sponsor", { sponsor, op: opFor(USER, 0n, ping()) })).body as { paymasterAndData: Hex; key: Hex };

  const packed = {
    sender: USER, nonce: "0", initCode: "0x", callData: ping(),
    accountGasLimits: `0x${(600000n).toString(16).padStart(32, "0")}${(150000n).toString(16).padStart(32, "0")}`,
    preVerificationGas: "60000",
    gasFees: `0x${"0".repeat(32)}${(40000000n).toString(16).padStart(32, "0")}`,
    paymasterAndData: s.paymasterAndData,
    signature: `0x${"11".repeat(65)}`,
  };

  // Not ours: a paymaster field pointing elsewhere, an unknown key, a forged sponsorship signature.
  const elsewhere = await open("submit", { op: { ...packed, paymasterAndData: `0x${"00".repeat(20)}${s.paymasterAndData.slice(42)}` } });
  assert.equal((elsewhere.body as { reason: string }).reason, "not_our_paymaster");
  const forged = `${s.paymasterAndData.slice(0, -130)}${(await stranger.signMessage({ message: { raw: `0x${"ab".repeat(32)}` } })).slice(2)}` as Hex;
  const notOurs = await open("submit", { op: { ...packed, paymasterAndData: forged } });
  assert.equal((notOurs.body as { reason: string }).reason, "sponsorship_not_ours");
  const tampered = await open("submit", { op: { ...packed, callData: ping("other") } });
  assert.equal((tampered.body as { reason: string }).reason, "sponsorship_not_ours", "a changed field breaks the signature");
  assert.equal(chain.submitted.length, 0, "nothing reached the chain");

  // Ours: bundled, and the charge is read from the escrow, fee included.
  chain.settle(sponsor, s.key, 1200n);
  const landed = await open("submit", { op: packed });
  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  assert.deepEqual(landed.body, { txHash: `0x${"cc".repeat(32)}`, userOpHash: `0x${"ab".repeat(32)}`, success: true, charged: "1200", key: s.key });
  assert.equal(chain.submitted.length, 1);
  const again = await open("submit", { op: packed });
  assert.deepEqual(again.body, landed.body, "a second submit answers from the record");
  assert.equal(chain.submitted.length, 1, "and does not bundle twice");
  const [op] = await store.listOps(sponsor, 1);
  assert.equal(op?.charged, "1200");
  assert.ok(op?.landedAt);

  // Expired: signed, never landed, past its window.
  clock = new Date("2026-09-15T11:00:00.000Z");
  const late = (await open("sponsor", { sponsor, op: opFor(USER, 1n, ping()) })).body as { paymasterAndData: Hex; key: Hex };
  clock = new Date("2026-09-15T12:00:00.000Z");
  const expired = await open("submit", { op: { ...packed, nonce: "1", paymasterAndData: late.paymasterAndData } });
  assert.equal((expired.body as { reason: string }).reason, "sponsorship_expired");
  const status = (await signed("status", { sponsor })).body as { staleKeys: Hex[] };
  assert.deepEqual(status.staleKeys, [late.key], "a close should roll this key back");
  clock = new Date("2026-09-15T10:00:00.000Z");
});

test("the dashboard shows spend by day, target and user hash, and never an address", async () => {
  const { chain, signed, open } = setup();
  const { sponsor } = (await signed("register", { policy: policy() })).body as { sponsor: Hex };
  chain.fund(sponsor, 10n ** 16n);
  const other = "0x00000000000000000000000000000000000000f2" as Address;
  await open("sponsor", { sponsor, op: opFor(USER, 0n, ping()) });
  await open("sponsor", { sponsor, op: opFor(other, 0n, ping()) });

  const asStranger = await signed("status", { sponsor }, stranger);
  assert.equal(asStranger.status, 403, "only the sponsor reads its dashboard");

  const r = await signed("status", { sponsor });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const status = r.body as { budget: { funded: string; unused: string }; feeBps: number; paymasterDeposit: string; spend: { byDay: unknown[]; byTarget: Array<{ target: Address; ops: number }>; byUser: unknown[] }; ops: Array<Record<string, unknown>> };
  assert.equal(status.budget.funded, (10n ** 16n).toString());
  assert.equal(status.feeBps, 2000);
  assert.equal(status.spend.byDay.length, 1);
  assert.deepEqual(status.spend.byTarget.map((t) => [t.target, t.ops]), [[GAME, 2]]);
  assert.equal(status.spend.byUser.length, 2);
  assert.equal(status.ops.length, 2);
  const text = JSON.stringify(status).toLowerCase();
  assert.ok(!text.includes(USER.toLowerCase()) && !text.includes(other.toLowerCase()), "no user address in the dashboard");

  const list = await signed("list", {});
  assert.deepEqual((list.body as Array<{ sponsor: Hex }>).map((x) => x.sponsor), [sponsor]);
  const notMine = await signed("policy", { sponsor, policy: policy() }, stranger);
  assert.equal(notMine.status, 403);
});
