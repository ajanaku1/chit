/**
 * Selling a fleet's tokens through the operator (docs/design-sell.md).
 *
 * The deployed contracts cannot sell for a fleet, so the fleet's owner keys
 * send the tokens to the operator with `withdrawToken`, and this sells them
 * and pays the ETH to the depositor's payout wallet. A transfer counts only
 * when the chain shows it, from an account enrolled in the campaign, to the
 * operator, and only once ever. Every send is recorded before it leaves (the
 * chain-pool lifecycle), so a sale whose outcome was never seen is resumed by
 * its hash and never sent twice. Chain access is the `SellChain` port.
 */
import { encodeFunctionData, parseAbi } from "viem";

import type { WriteOutcome } from "./chain-pool.js";
import type { Sale, StorePort } from "./store.js";
import { anyEntry, leastOut, type TokenRegistry } from "./token-registry.js";
import type { Address, Hex } from "./types.js";
import { encodeV4TokenSell, sellApprovals, type PoolKey } from "./v4-swap.js";

export type SendStep = { to: Address; data?: Hex; value?: bigint; record: (hash: Hex, nonce: number) => Promise<void> };

export type SellChain = {
  /** The ERC-20 transfers a mined transaction emitted; `mined: false` when it has no successful receipt. */
  transfersIn(hash: Hex): Promise<{ mined: boolean; transfers: { token: Address; from: Address; to: Address; amount: bigint }[] }>;
  enrolled(campaign: Hex, account: Address): Promise<boolean>;
  /** ETH out for `amountIn` of the token through this pool, fee and impact included (a hook's own fee is not seen). */
  sellQuote(token: Address, amountIn: bigint, poolKey: PoolKey): Promise<bigint>;
  /** One operator transaction: sign, `record`, broadcast, wait (chain-pool.ts `signAndBroadcast`). */
  send(step: SendStep): Promise<WriteOutcome>;
  resolve(hash: Hex, nonce: number): Promise<WriteOutcome>;
  /** The ETH the operator gained in this transaction's block, gas paid added back. Needs that block's state, which a public RPC keeps for minutes. */
  ethReceived(hash: Hex): Promise<bigint>;
  /**
   * A send that also measures what it brought: the operator's balance just before the broadcast and just after the
   * receipt, both inside the operator lock and both "latest", so no old state is needed. Optional; without it the
   * swap is measured afterwards with ethReceived.
   */
  swap?(step: SendStep): Promise<{ outcome: WriteOutcome; received?: bigint }>;
  balance(address: Address): Promise<bigint>;
  /** A fleet account's owner key, read from the account itself. Optional so fakes that predate it still type-check. */
  ownerOf?(account: Address): Promise<Address>;
  /** Whether code lives at the address. Optional; without it a contract payout is not caught before the payout fails. */
  isContract?(address: Address): Promise<boolean>;
  /** The token an account holds. Optional; without it every owner key gets gas, holding or not. */
  tokenBalance?(token: Address, account: Address): Promise<bigint>;
};

export type SellDeps = {
  store: StorePort;
  operator: Address;
  router: Address;
  registry: TokenRegistry;
  chain: SellChain;
  now: () => number;
  /** 0 to 1; places the payout inside its wait. */
  random: () => number;
  alert?: (summary: string) => Promise<void>;
};

export type SaleRequest = { campaign: Hex; owner: Address; token: Address; payout: Address; transfers: Hex[] };

export class SellRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SellRefused";
  }
}

export const MAX_ATTEMPTS = 3;
/** Gas an owner key needs for one `withdrawToken`, with room: 0.00002 ETH, a pause-sized call being ~0.0000021 on 4663. */
export const OWNER_GAS_WEI = 20_000_000_000_000n;
const WAIT_MIN_MS = 10 * 60_000;
const WAIT_MAX_MS = 30 * 60_000;
/** Past this a sale is late: the longest wait is 30 minutes, and the sweep runs every 5. */
const HELD_MS = 60 * 60_000;
const SWAP_DEADLINE_S = 600;
const FOREVER = Number.MAX_SAFE_INTEGER;
const ERC20_TRANSFER = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const save = async (deps: SellDeps, sale: Sale): Promise<Sale> => { await deps.store.sales.put(sale); return sale; };

/** What one transfer contributes: the token, to the operator, from an enrolled account; counted once ever. */
const counted = async (deps: SellDeps, req: SaleRequest, hash: Hex): Promise<bigint> => {
  const seen = await deps.chain.transfersIn(hash);
  if (!seen.mined) return 0n;
  let amount = 0n;
  for (const t of seen.transfers) {
    if (same(t.token, req.token) && same(t.to, deps.operator) && (await deps.chain.enrolled(req.campaign, t.from))) amount += t.amount;
  }
  // Burned only once it is known to count, and before the sale exists: a hash is never worth two sales.
  if (amount === 0n || !(await deps.store.burnNonce(`sale:transfer:${hash}`, FOREVER, deps.now()))) return 0n;
  return amount;
};

export const openSale = async (deps: SellDeps, req: SaleRequest): Promise<Sale> => {
  if (same(req.payout, req.owner)) throw new SellRefused("payout_is_main_wallet");
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.payout) || /^0x0{40}$/.test(req.payout)) throw new SellRefused("payout_invalid");
  if (!anyEntry(deps.registry, req.token)) throw new SellRefused("token_not_listed");
  // A contract may refuse plain ETH, and then the payout fails every sweep with the tokens already sold.
  if (await deps.chain.isContract?.(req.payout)) throw new SellRefused("payout_is_contract");
  const claimed: Hex[] = [];
  let total = 0n;
  for (const hash of new Set(req.transfers.map((h) => h.toLowerCase() as Hex))) {
    const amount = await counted(deps, req, hash);
    if (amount > 0n) { claimed.push(hash); total += amount; }
  }
  if (total === 0n) throw new SellRefused("no_transfer_counted");
  return save(deps, {
    id: claimed[0]!, campaign: req.campaign, owner: req.owner, token: req.token, payout: req.payout,
    amountIn: total.toString(), transfers: claimed, state: "awaiting", attempts: 0, createdAt: deps.now(),
  });
};

/**
 * Every sale with work left, each under its own lock and re-read inside it:
 * two instances sweeping together advance a sale once, never sell it twice.
 * One sale that throws does not stop the rest.
 */
export const advancePending = async (deps: SellDeps): Promise<Sale[]> => {
  const done: Sale[] = [];
  for (const pending of await deps.store.sales.pending()) {
    try {
      const advanced = await deps.store.withLock(`sale:${pending.id}`, async () => {
        const fresh = await deps.store.sales.get(pending.id);
        return fresh ? advanceSale(deps, fresh) : undefined;
      });
      if (advanced) done.push(advanced);
      await warnIfHeld(deps, advanced ?? pending);
    } catch (error) {
      await deps.alert?.(`sale ${pending.id} could not advance: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return done;
};

/** Says once an hour that a sale has been open over an hour, so a person looks before the depositor asks. */
const warnIfHeld = async (deps: SellDeps, sale: Sale): Promise<void> => {
  const now = deps.now();
  if (sale.state === "paid" || sale.state === "returned" || now - sale.createdAt < HELD_MS) return;
  if (!(await deps.store.burnNonce(`sale:held:${sale.id}`, now + HELD_MS, now))) return;
  await deps.alert?.(`sale ${sale.id} held ${Math.floor((now - sale.createdAt) / 60_000)} min (${sale.state}${sale.reason ? `, ${sale.reason}` : ""}); look at it`);
};

/**
 * Tops each owner key up to OWNER_GAS_WEI from the operator, so it can send its
 * account's tokens (docs/design-sell.md). The chain already shows Chit funding
 * fleets, so this links nothing new. Returns the keys it sent to.
 */
export const topUpOwners = async (deps: SellDeps, owners: readonly Address[]): Promise<Address[]> => {
  const topped: Address[] = [];
  for (const owner of owners) {
    const held = await deps.chain.balance(owner);
    if (held >= OWNER_GAS_WEI) continue;
    // Once an hour per key, counted only when gas is actually sent: a key that needed none, or an ask that failed before sending, costs nothing.
    const now = deps.now();
    if (!(await deps.store.burnNonce(`sellgas:${owner.toLowerCase()}`, now + 60 * 60_000, now))) continue;
    const outcome = await deps.chain.send({ to: owner, value: OWNER_GAS_WEI - held, record: async () => undefined });
    if (outcome.status === "mined") topped.push(owner);
  }
  return topped;
};

/** One sweep's worth of progress: sell, settle a send already made, pay out when due, or give the tokens back. */
export const advanceSale = async (deps: SellDeps, sale: Sale): Promise<Sale> => {
  if (sale.state === "sold") return payOut(deps, sale);
  if (sale.state !== "awaiting") return sale;
  if (sale.payoutTx) return settleReturn(deps, sale, await deps.chain.resolve(sale.payoutTx, sale.payoutNonce ?? 0));
  if (sale.saleTx) return settleSwap(deps, sale, await deps.chain.resolve(sale.saleTx, sale.saleNonce ?? 0));
  return sale.attempts >= MAX_ATTEMPTS ? returnTokens(deps, sale) : trySell(deps, sale);
};

const miss = async (deps: SellDeps, sale: Sale, reason: string): Promise<Sale> => {
  const { saleTx: _tx, saleNonce: _nonce, ...rest } = sale;
  const missed = await save(deps, { ...rest, attempts: sale.attempts + 1, reason });
  if (missed.attempts === MAX_ATTEMPTS) await deps.alert?.(`sale ${sale.id} missed ${MAX_ATTEMPTS} times (${reason}); its tokens go to the payout wallet`);
  return missed;
};

const trySell = async (deps: SellDeps, sale: Sale): Promise<Sale> => {
  const entry = anyEntry(deps.registry, sale.token)!;
  const amountIn = BigInt(sale.amountIn);
  const quoted = await deps.chain.sellQuote(sale.token, amountIn, entry.poolKey);
  const minOut = leastOut(quoted, entry.slippageBps);
  if (minOut === 0n) return miss(deps, sale, "no_quote");
  const expiry = Math.floor(deps.now() / 1000) + SWAP_DEADLINE_S;
  // Exactly this sale's amount, never an open allowance on the operator's tokens.
  for (const approval of sellApprovals(sale.token, deps.router, amountIn, expiry)) {
    const outcome = await deps.chain.send({ to: approval.to, data: approval.data, record: async () => undefined });
    if (outcome.status !== "mined") return miss(deps, sale, "approval_failed");
  }
  const data = encodeV4TokenSell({ token: sale.token, amountIn, minOut, deadline: BigInt(expiry), poolKey: entry.poolKey });
  let recorded = sale;
  const step: SendStep = { to: deps.router, data, record: async (hash, nonce) => { recorded = await save(deps, { ...sale, saleTx: hash, saleNonce: nonce, quotedOut: quoted.toString(), minOut: minOut.toString() }); } };
  const { outcome, received } = deps.chain.swap ? await deps.chain.swap(step) : { outcome: await deps.chain.send(step), received: undefined };
  return settleSwap(deps, recorded, outcome, received);
};

/**
 * What a mined swap brought: measured at send time when it could be, else read from its block, else, once the RPC no
 * longer keeps that block, the least the swap could have returned (it landed, so it met its minimum), with an alert so
 * a person pays the rest. A sale is never left waiting on state that will not come back.
 */
const receivedBy = async (deps: SellDeps, sale: Sale, hash: Hex, measured: bigint | undefined): Promise<bigint> => {
  if (measured !== undefined) return measured;
  try {
    return await deps.chain.ethReceived(hash);
  } catch (error) {
    const floor = BigInt(sale.minOut ?? "0");
    await deps.alert?.(`sale ${sale.id} settled at its guaranteed minimum (${floor} wei): the swap's block is no longer readable (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); pay the difference by hand`);
    return floor;
  }
};

const settleSwap = async (deps: SellDeps, sale: Sale, outcome: WriteOutcome, measured?: bigint): Promise<Sale> => {
  if (outcome.status === "unknown") return sale;
  if (outcome.status !== "mined") return miss(deps, sale, "swap_did_not_fill");
  // Never more than the quote: an unrelated inflow to the operator in the swap's block is not the depositor's.
  const received = await receivedBy(deps, sale, outcome.hash, measured);
  const cap = sale.quotedOut === undefined ? received : BigInt(sale.quotedOut);
  const ethOut = received < cap ? received : cap;
  const payoutDueAt = deps.now() + WAIT_MIN_MS + Math.floor(deps.random() * (WAIT_MAX_MS - WAIT_MIN_MS));
  const { reason: _reason, ...rest } = sale;
  return save(deps, { ...rest, state: "sold", saleTx: outcome.hash, ethOut: ethOut.toString(), payoutDueAt });
};

const payOut = async (deps: SellDeps, sale: Sale): Promise<Sale> => {
  if (sale.payoutTx) return settlePayout(deps, sale, await deps.chain.resolve(sale.payoutTx, sale.payoutNonce ?? 0));
  if (deps.now() < (sale.payoutDueAt ?? 0)) return sale;
  let recorded = sale;
  const outcome = await deps.chain.send({
    to: sale.payout, value: BigInt(sale.ethOut ?? "0"),
    record: async (hash, nonce) => { recorded = await save(deps, { ...sale, payoutTx: hash, payoutNonce: nonce }); },
  });
  return settlePayout(deps, recorded, outcome);
};

const settlePayout = async (deps: SellDeps, sale: Sale, outcome: WriteOutcome): Promise<Sale> => {
  if (outcome.status === "unknown") return sale;
  if (outcome.status === "mined") return save(deps, { ...sale, state: "paid", payoutTx: outcome.hash });
  const { payoutTx: _tx, payoutNonce: _nonce, ...rest } = sale;
  await deps.alert?.(`payout for sale ${sale.id} did not land (${outcome.status}); it is tried again`);
  return save(deps, rest);
};

const returnTokens = async (deps: SellDeps, sale: Sale): Promise<Sale> => {
  const data = encodeFunctionData({ abi: ERC20_TRANSFER, functionName: "transfer", args: [sale.payout, BigInt(sale.amountIn)] });
  let recorded = sale;
  const outcome = await deps.chain.send({ to: sale.token, data, record: async (hash, nonce) => { recorded = await save(deps, { ...sale, payoutTx: hash, payoutNonce: nonce }); } });
  return settleReturn(deps, recorded, outcome);
};

const settleReturn = async (deps: SellDeps, sale: Sale, outcome: WriteOutcome): Promise<Sale> => {
  if (outcome.status === "unknown") return sale;
  if (outcome.status === "mined") return save(deps, { ...sale, state: "returned", payoutTx: outcome.hash });
  const { payoutTx: _tx, payoutNonce: _nonce, ...rest } = sale;
  return save(deps, rest);
};
