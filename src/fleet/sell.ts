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

export type SellChain = {
  /** The ERC-20 transfers a mined transaction emitted; `mined: false` when it has no successful receipt. */
  transfersIn(hash: Hex): Promise<{ mined: boolean; transfers: { token: Address; from: Address; to: Address; amount: bigint }[] }>;
  enrolled(campaign: Hex, account: Address): Promise<boolean>;
  /** ETH out for `amountIn` of the token through this pool, fee and impact included (a hook's own fee is not seen). */
  sellQuote(token: Address, amountIn: bigint, poolKey: PoolKey): Promise<bigint>;
  /** One operator transaction: sign, `record`, broadcast, wait (chain-pool.ts `signAndBroadcast`). */
  send(step: { to: Address; data?: Hex; value?: bigint; record: (hash: Hex, nonce: number) => Promise<void> }): Promise<WriteOutcome>;
  resolve(hash: Hex, nonce: number): Promise<WriteOutcome>;
  /** The ETH the operator gained in this transaction's block, gas paid added back. */
  ethReceived(hash: Hex): Promise<bigint>;
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
const WAIT_MIN_MS = 10 * 60_000;
const WAIT_MAX_MS = 30 * 60_000;
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
    } catch (error) {
      await deps.alert?.(`sale ${pending.id} could not advance: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return done;
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
  const outcome = await deps.chain.send({ to: deps.router, data, record: async (hash, nonce) => { recorded = await save(deps, { ...sale, saleTx: hash, saleNonce: nonce, quotedOut: quoted.toString() }); } });
  return settleSwap(deps, recorded, outcome);
};

const settleSwap = async (deps: SellDeps, sale: Sale, outcome: WriteOutcome): Promise<Sale> => {
  if (outcome.status === "unknown") return sale;
  if (outcome.status !== "mined") return miss(deps, sale, "swap_did_not_fill");
  // Never more than the quote: an unrelated inflow to the operator in the swap's block is not the depositor's.
  const received = await deps.chain.ethReceived(outcome.hash);
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
