import assert from "node:assert/strict";
import test from "node:test";

import { RecoverFlowError, runRecovery, type RecoverPorts } from "../src/fleet/recover-eth-flow.js";

/**
 * The page's side of taking a finished fleet's leftover ETH home: unlock the
 * backup, ask for gas, have each owner key send its account's whole balance to
 * the payout wallet. What is pinned: the main wallet is refused before anything
 * is unlocked; only accounts that hold ETH send, each with its own key, all of
 * it; an account whose key is not in the backup is skipped, never guessed;
 * nothing to send is said, not reported as zero.
 */

type Hex = `0x${string}`;
const a = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const MAIN = a(0x1);
const PAYOUT = a(0x2);
const ACCOUNTS = [a(0xa1), a(0xa2), a(0xa3)];
const OWNERS: Record<string, Hex> = { [a(0xa1)]: a(0xb1), [a(0xa2)]: a(0xb2), [a(0xa3)]: a(0xb3) };

const portsOf = (over: { balances?: Record<string, bigint>; keys?: Hex[] } = {}) => {
  const calls: string[] = [];
  const sends: { key: Hex; account: Hex; to: Hex; amount: bigint }[] = [];
  const ports: RecoverPorts = {
    async recover() { calls.push("recover"); return (over.keys ?? Object.values(OWNERS)).map((owner) => ({ ownerAddress: owner, privateKey: `0x${owner.slice(2).padStart(64, "f")}` as Hex })); },
    async api(action) { calls.push(action); return { topped: [] }; },
    async ownerOf(account) { return OWNERS[account]!; },
    async ethBalance(account) { return over.balances?.[account] ?? 200_000_000_000_000n; },
    async withdrawEth(privateKey, account, to, amount) { sends.push({ key: privateKey, account, to, amount }); return `0x${account.slice(2).padStart(64, "0")}` as Hex; },
  };
  return { ports, calls, sends };
};

const input = (over: Partial<Parameters<typeof runRecovery>[1]> = {}) => ({ campaign: "c-1", payout: PAYOUT, main: MAIN, envelopeJson: "{}", accounts: ACCOUNTS, ...over });

test("each account that holds ETH sends all of it to the payout wallet, with its own key, after gas is asked for", async () => {
  const { ports, calls, sends } = portsOf({ balances: { [a(0xa2)]: 0n } });
  const steps: string[] = [];
  const result = await runRecovery(ports, input(), (s) => steps.push(s));
  assert.deepEqual(calls, ["recover", "recoverGas"]);
  assert.deepEqual(sends.map((s) => ({ account: s.account, to: s.to, amount: s.amount })), [
    { account: a(0xa1), to: PAYOUT, amount: 200_000_000_000_000n },
    { account: a(0xa3), to: PAYOUT, amount: 200_000_000_000_000n },
  ], "the empty account sends nothing");
  assert.ok(sends.every((s) => s.key.endsWith(OWNERS[s.account]!.slice(2))), "every account signs with its own owner key");
  assert.equal(result.transfers.length, 2);
  assert.equal(result.total, 400_000_000_000_000n);
  assert.deepEqual(steps, ["unlocking", "gas", "sending"]);
});

test("the main wallet is refused as the payout before the backup is even opened", async () => {
  const { ports, calls } = portsOf();
  await assert.rejects(runRecovery(ports, input({ payout: MAIN.toUpperCase().replace("0X", "0x") as Hex })), (e: Error) => e instanceof RecoverFlowError && e.reason === "payout_is_main_wallet");
  assert.deepEqual(calls, [], "nothing unlocked, nothing asked");
});

test("an account whose key is not in the backup is skipped, never guessed", async () => {
  const { ports, sends } = portsOf({ keys: [a(0xb1)] });
  await runRecovery(ports, input());
  assert.deepEqual(sends.map((s) => s.account), [a(0xa1)]);
});

test("nothing to send is said", async () => {
  const { ports, sends } = portsOf({ balances: { [a(0xa1)]: 0n, [a(0xa2)]: 0n, [a(0xa3)]: 0n } });
  await assert.rejects(runRecovery(ports, input()), (e: Error) => e instanceof RecoverFlowError && e.reason === "nothing_to_recover");
  assert.equal(sends.length, 0);
});

test("progress counts the wallets that hold ETH, as each one's transfer lands", async () => {
  const { ports } = portsOf({ balances: { [a(0xa2)]: 0n } });
  const seen: [number, number][] = [];
  await runRecovery(ports, input({ progress: (sent, of) => { seen.push([sent, of]); } }));
  assert.deepEqual(seen, [[0, 2], [1, 2], [2, 2]]);
});
