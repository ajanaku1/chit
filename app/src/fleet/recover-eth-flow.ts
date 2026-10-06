/**
 * The page's side of taking a finished fleet's leftover ETH home. Each fleet
 * account was seeded with gas from the pool; closing the fleet moves none of
 * it, since only the account's own owner key can (`withdrawEth`), and those
 * keys live in the backup made at setup. So, as a sale does (sell-flow.ts):
 * unlock the backup with the main wallet's signature, ask the service for
 * gas for the owner keys, and have each key send its account's whole balance
 * to the payout wallet. Chain and service access are the ports.
 */

type Hex = `0x${string}`;

export type RecoverStep = "unlocking" | "gas" | "sending";

export type RecoverPorts = {
  /** The backup's accounts, unlocked with the main wallet's signature (vault.ts `recoverVault`). */
  recover(envelopeJson: string): Promise<{ ownerAddress: Hex; privateKey: Hex }[]>;
  /** A signed fleet API call. */
  api(action: "recoverGas", body: Record<string, unknown>): Promise<Record<string, unknown>>;
  ownerOf(account: Hex): Promise<Hex>;
  ethBalance(account: Hex): Promise<bigint>;
  /** The owner key calls `withdrawEth` on its account; resolves with the hash once mined, throws if it failed. */
  withdrawEth(privateKey: Hex, account: Hex, to: Hex, amount: bigint): Promise<Hex>;
};

export type RecoverInput = {
  campaign: string; payout: Hex; main: Hex; envelopeJson: string; accounts: readonly Hex[];
  /** How many of the wallets that hold ETH have sent it: first with 0, then as each transfer lands. */
  progress?: (sent: number, of: number) => void;
};

export type RecoverResult = { transfers: Hex[]; total: bigint };

export class RecoverFlowError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RecoverFlowError";
  }
}

const same = (x: string, y: string): boolean => x.toLowerCase() === y.toLowerCase();

type Holder = { account: Hex; privateKey: Hex; amount: bigint };

/** The accounts that hold ETH and whose key is in the backup; one without its key is skipped, never guessed. */
const holdersOf = async (ports: RecoverPorts, input: RecoverInput, keys: { ownerAddress: Hex; privateKey: Hex }[]): Promise<Holder[]> => {
  const holders: Holder[] = [];
  for (const account of input.accounts) {
    const owner = await ports.ownerOf(account);
    const key = keys.find((k) => same(k.ownerAddress, owner));
    if (!key) continue;
    const amount = await ports.ethBalance(account);
    if (amount > 0n) holders.push({ account, privateKey: key.privateKey, amount });
  }
  return holders;
};

export const runRecovery = async (ports: RecoverPorts, input: RecoverInput, step: (s: RecoverStep) => void = () => undefined): Promise<RecoverResult> => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.payout)) throw new RecoverFlowError("payout_invalid");
  // Refused before the backup is opened: paying the main wallet would link it to the fleet.
  if (same(input.payout, input.main)) throw new RecoverFlowError("payout_is_main_wallet");
  step("unlocking");
  const keys = await ports.recover(input.envelopeJson);
  step("gas");
  await ports.api("recoverGas", { campaign: input.campaign, payout: input.payout, accounts: input.accounts });
  step("sending");
  const holders = await holdersOf(ports, input, keys);
  if (holders.length === 0) throw new RecoverFlowError("nothing_to_recover");
  const transfers: Hex[] = [];
  let total = 0n;
  input.progress?.(0, holders.length);
  for (const holder of holders) {
    transfers.push(await ports.withdrawEth(holder.privateKey, holder.account, input.payout, holder.amount));
    total += holder.amount;
    input.progress?.(transfers.length, holders.length);
  }
  return { transfers, total };
};
