/**
 * The page's side of selling a fleet's tokens (docs/design-sell.md). The
 * fleet's owner keys live only in the backup made at setup, so the page
 * unlocks it with the main wallet's signature, asks the service for gas and
 * the operator's address, has each owner key send its account's tokens to the
 * operator, and hands the transaction hashes to the service, which sells and
 * pays the payout wallet later. Chain and service access are the ports.
 */

type Hex = `0x${string}`;

export type SellStep = "unlocking" | "gas" | "sending" | "selling";

export type SellFlowPorts = {
  /** The backup's accounts, unlocked with the main wallet's signature (vault.ts `recoverVault`). */
  recover(envelopeJson: string): Promise<{ ownerAddress: Hex; privateKey: Hex }[]>;
  /** A signed fleet API call. */
  api(action: "sellGas" | "sell", body: Record<string, unknown>): Promise<Record<string, unknown>>;
  ownerOf(account: Hex): Promise<Hex>;
  tokenBalance(token: Hex, account: Hex): Promise<bigint>;
  /** The owner key calls `withdrawToken` on its account; resolves with the hash once mined, throws if it failed. */
  withdraw(privateKey: Hex, account: Hex, token: Hex, to: Hex, amount: bigint): Promise<Hex>;
};

export type SellInput = {
  campaign: string; token: Hex; payout: Hex; main: Hex; envelopeJson: string; accounts: readonly Hex[];
  /** Transfers sent on an earlier try whose sale was never confirmed; the service counts each hash once, so resending is safe. */
  pending?: readonly Hex[];
  /** Called with every transfer before the service is asked to sell, so a failed ask loses none of them. */
  keep?: (transfers: Hex[]) => void;
  /** How many of the wallets that hold the token have sent it: first with 0, then as each transfer lands. */
  progress?: (sent: number, of: number) => void;
};

export class SellFlowError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "SellFlowError";
  }
}

const same = (x: string, y: string): boolean => x.toLowerCase() === y.toLowerCase();

type Holder = { account: Hex; privateKey: Hex; amount: bigint };

/** The accounts that hold the token and whose key is in the backup; one without its key is skipped, never guessed. */
const holdersOf = async (ports: SellFlowPorts, input: SellInput, keys: { ownerAddress: Hex; privateKey: Hex }[]): Promise<Holder[]> => {
  const holders: Holder[] = [];
  for (const account of input.accounts) {
    const owner = await ports.ownerOf(account);
    const key = keys.find((k) => same(k.ownerAddress, owner));
    if (!key) continue;
    const amount = await ports.tokenBalance(input.token, account);
    if (amount > 0n) holders.push({ account, privateKey: key.privateKey, amount });
  }
  return holders;
};

/** Each holder sends all of it to the operator, signed by its own key, counted as it lands. */
const sendAll = async (ports: SellFlowPorts, input: SellInput, keys: { ownerAddress: Hex; privateKey: Hex }[], operator: Hex): Promise<Hex[]> => {
  const holders = await holdersOf(ports, input, keys);
  const hashes: Hex[] = [];
  input.progress?.(0, holders.length);
  for (const holder of holders) {
    hashes.push(await ports.withdraw(holder.privateKey, holder.account, input.token, operator, holder.amount));
    input.progress?.(hashes.length, holders.length);
  }
  return hashes;
};

export const runSale = async (ports: SellFlowPorts, input: SellInput, step: (s: SellStep) => void = () => undefined): Promise<unknown> => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.payout)) throw new SellFlowError("payout_invalid");
  // Refused here as well as by the service, before the backup is opened: paying the main wallet would link it to the fleet.
  if (same(input.payout, input.main)) throw new SellFlowError("payout_is_main_wallet");
  step("unlocking");
  const keys = await ports.recover(input.envelopeJson);
  step("gas");
  // The fleet's accounts go with the ask: a fleet the service reloaded from the chain knows no owner keys until it reads them there.
  const operator = String((await ports.api("sellGas", { campaign: input.campaign, token: input.token, payout: input.payout, accounts: input.accounts }))["operator"] ?? "") as Hex;
  if (!/^0x[0-9a-fA-F]{40}$/.test(operator)) throw new SellFlowError("operator_unknown");
  step("sending");
  const transfers = [...(input.pending ?? []), ...(await sendAll(ports, input, keys, operator))];
  if (transfers.length === 0) throw new SellFlowError("nothing_to_sell");
  input.keep?.(transfers);
  step("selling");
  return (await ports.api("sell", { campaign: input.campaign, token: input.token, payout: input.payout, transfers }))["sale"];
};
