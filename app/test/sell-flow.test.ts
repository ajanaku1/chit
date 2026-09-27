import assert from "node:assert/strict";
import test from "node:test";

import { SellFlowError, runSale, type SellFlowPorts } from "../src/fleet/sell-flow.js";

/**
 * The page's side of a sale (docs/design-sell.md): unlock the backup, ask for
 * gas, have each owner key send its account's tokens to the operator, and hand
 * the hashes to the service. What is pinned: the main wallet is refused before
 * anything is unlocked; only accounts that hold the token send, each with its
 * own key; an account whose key is not in the backup is skipped, never guessed;
 * nothing to send is said, not sold as zero.
 */

type Hex = `0x${string}`;
const a = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const MAIN = a(0x1);
const PAYOUT = a(0x2);
const TOKEN = a(0x77);
const OPERATOR = a(0x0e);
const ACCOUNTS = [a(0xa1), a(0xa2), a(0xa3)];
const OWNERS: Record<string, Hex> = { [a(0xa1)]: a(0xb1), [a(0xa2)]: a(0xb2), [a(0xa3)]: a(0xb3) };

const portsOf = (over: { balances?: Record<string, bigint>; keys?: Hex[] } = {}) => {
  const calls: string[] = [];
  const sends: { key: Hex; account: Hex; to: Hex; amount: bigint }[] = [];
  const ports: SellFlowPorts = {
    async recover() { calls.push("recover"); return (over.keys ?? Object.values(OWNERS)).map((owner) => ({ ownerAddress: owner, privateKey: `0x${owner.slice(2).padStart(64, "f")}` as Hex })); },
    async api(action, body) {
      calls.push(action);
      if (action === "sellGas") return { operator: OPERATOR, topped: [] };
      return { sale: { state: "sold", transfers: body["transfers"] } };
    },
    async ownerOf(account) { return OWNERS[account]!; },
    async tokenBalance(_token, account) { return over.balances?.[account] ?? 100n; },
    async withdraw(privateKey, account, _token, to, amount) { sends.push({ key: privateKey, account, to, amount }); return `0x${account.slice(2).padStart(64, "0")}` as Hex; },
  };
  return { ports, calls, sends };
};

const input = (over: Partial<Parameters<typeof runSale>[1]> = {}) => ({ campaign: "c-1", token: TOKEN, payout: PAYOUT, main: MAIN, envelopeJson: "{}", accounts: ACCOUNTS, ...over });

test("each account that holds the token sends it all to the operator, with its own key, and the service gets the hashes", async () => {
  const { ports, calls, sends } = portsOf({ balances: { [a(0xa2)]: 0n } });
  const steps: string[] = [];
  const sale = await runSale(ports, input(), (s) => steps.push(s));
  assert.deepEqual(calls, ["recover", "sellGas", "sell"]);
  assert.deepEqual(sends.map((s) => ({ account: s.account, to: s.to, amount: s.amount })), [
    { account: a(0xa1), to: OPERATOR, amount: 100n },
    { account: a(0xa3), to: OPERATOR, amount: 100n },
  ], "the empty account sends nothing");
  assert.ok(sends.every((s) => s.key.endsWith(OWNERS[s.account]!.slice(2))), "every account signs with its own owner key");
  assert.deepEqual((sale as { transfers: Hex[] }).transfers.length, 2);
  assert.deepEqual(steps, ["unlocking", "gas", "sending", "selling"]);
});

test("the main wallet is refused as the payout before the backup is even opened", async () => {
  const { ports, calls } = portsOf();
  await assert.rejects(runSale(ports, input({ payout: MAIN.toUpperCase().replace("0X", "0x") as Hex })), (e: Error) => e instanceof SellFlowError && e.reason === "payout_is_main_wallet");
  assert.deepEqual(calls, [], "nothing unlocked, nothing asked");
});

test("an account whose key is not in the backup is skipped, never guessed", async () => {
  const { ports, sends } = portsOf({ keys: [a(0xb1)] });
  await runSale(ports, input());
  assert.deepEqual(sends.map((s) => s.account), [a(0xa1)]);
});

test("nothing to send is said, and nothing is sold", async () => {
  const { ports, calls } = portsOf({ balances: { [a(0xa1)]: 0n, [a(0xa2)]: 0n, [a(0xa3)]: 0n } });
  await assert.rejects(runSale(ports, input()), (e: Error) => e instanceof SellFlowError && e.reason === "nothing_to_sell");
  assert.ok(!calls.includes("sell"));
});

test("transfers already sent are kept before the sale is asked for, and sent again on the next try", async () => {
  const { ports } = portsOf({ balances: { [a(0xa1)]: 0n, [a(0xa2)]: 0n, [a(0xa3)]: 0n } });
  const kept: Hex[][] = [];
  const earlier = [`0x${"ab".repeat(32)}` as Hex];
  const sale = await runSale(ports, input({ pending: earlier, keep: (h) => { kept.push(h); } }));
  assert.deepEqual((sale as { transfers: Hex[] }).transfers, earlier, "a fleet already emptied still sells what it sent last time");
  assert.deepEqual(kept, [earlier], "kept before the service was asked");
});

test("progress counts the wallets that actually hold the token, as each one's transfer lands", async () => {
  const { ports } = portsOf({ balances: { [a(0xa2)]: 0n } });
  const seen: [number, number][] = [];
  await runSale(ports, input({ progress: (sent, of) => { seen.push([sent, of]); } }));
  assert.deepEqual(seen, [[0, 2], [1, 2], [2, 2]], "two of the three hold it: 0 of 2 before, then each as it lands");
});
