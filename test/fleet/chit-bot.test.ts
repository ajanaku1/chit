import assert from "node:assert/strict";
import test from "node:test";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { BotChain } from "../../src/fleet/bot-chain.js";
import { ChitBot, type Update } from "../../src/fleet/bot-handlers.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";
import { MemoryBotWalletStore, openKey, sealKey } from "../../src/fleet/bot-wallets.js";
import type { Address, Hex } from "../../src/fleet/types.js";

/**
 * Chit Bot's whole conversation against a chain of maps: /start makes and
 * funds a wallet, buys and sells go through with hashes, refusals name why,
 * the group is told to go private, the faucet is once a day, and the
 * playground key is sealed at rest.
 */

const SECRET = "a-secret-long-enough-to-seal-keys-with-1234";
const FAUCET = "0x00000000000000000000000000000000000000fa" as Address;

/** ETH and token balances per address; a price of 1000 tokens per ETH; a faucet with a balance. */
const fakeChain = () => {
  const eth = new Map<string, bigint>([[FAUCET, parseEther("1")]]);
  const tokens = new Map<string, bigint>();
  const calls: string[] = [];
  const get = (m: Map<string, bigint>, a: string) => m.get(a.toLowerCase()) ?? 0n;
  const set = (m: Map<string, bigint>, a: string, v: bigint) => m.set(a.toLowerCase(), v);
  let n = 0;
  const hash = (): Hex => `0x${(++n).toString(16).padStart(64, "0")}`;
  let failNext = false;
  const chain: BotChain & { calls: string[]; eth: typeof eth; tokens: typeof tokens; failNextTrade: () => void; ownerOf: (key: Hex) => Address } = {
    chainId: 46630, token: "0x0000000000000000000000000000000000000fee" as Address, tokenSymbol: "FLEET", router: "0x0000000000000000000000000000000000000001" as Address,
    calls, eth, tokens,
    failNextTrade: () => { failNext = true; },
    ownerOf: (key) => privateKeyToAccount(key).address,
    ethBalance: async (a) => get(eth, a),
    tokenBalance: async (a) => get(tokens, a),
    quoteBuy: async (wei) => wei * 1000n,
    quoteSell: async (t) => t / 1000n,
    async buy(key, ethIn, minOut) {
      const a = privateKeyToAccount(key).address;
      calls.push(`buy ${ethIn} min ${minOut}`);
      if (failNext) { failNext = false; return { hash: hash(), ok: false }; }
      set(eth, a, get(eth, a) - ethIn - 1000n);
      set(tokens, a, get(tokens, a) + ethIn * 990n);
      return { hash: hash(), ok: true };
    },
    async sell(key, tokensIn, minOut) {
      const a = privateKeyToAccount(key).address;
      calls.push(`sell ${tokensIn} min ${minOut}`);
      set(tokens, a, get(tokens, a) - tokensIn);
      set(eth, a, get(eth, a) + tokensIn / 1010n - 1000n);
      return { hash: hash(), ok: true };
    },
    async send(key, to, wei) {
      const a = privateKeyToAccount(key).address;
      calls.push(`send ${wei} to ${to}`);
      set(eth, a, get(eth, a) - wei - 1000n);
      set(eth, to, get(eth, to) + wei);
      return { hash: hash(), ok: true };
    },
    async faucet(to, wei) {
      calls.push(`faucet ${wei}`);
      set(eth, FAUCET, get(eth, FAUCET) - wei);
      set(eth, to, get(eth, to) + wei);
      return { hash: hash(), ok: true };
    },
    faucetBalance: async () => get(eth, FAUCET),
    poolNumbers: async () => ({ address: "0x0000000000000000000000000000000000000900" as Address, heldWei: parseEther("0.1465"), totalDeposited: parseEther("0.15"), campaigns: 3n, paused: false }),
  };
  return chain;
};

const dm = (text: string, from = 7): Update => ({ message: { message_id: 1, text, chat: { id: from, type: "private" }, from: { id: from, first_name: "Lucian" } } });
const group = (text: string): Update => ({ message: { message_id: 1, text, chat: { id: -100, type: "supergroup" }, from: { id: 7 } } });
const tap = (data: string, from = 7): Update => ({ callback_query: { id: "cb", data, from: { id: from }, message: { message_id: 9, chat: { id: from, type: "private" } } } });

let clock = new Date("2026-09-16T10:00:00Z");
const setup = () => {
  const store = new MemoryBotWalletStore();
  const chain = fakeChain();
  const telegram = new RecordingTelegram();
  const bot = new ChitBot({ store, chain, telegram, keySecret: SECRET, botUsername: "chit_playground_bot", now: () => clock });
  return { store, chain, telegram, bot };
};

test("the playground key is sealed at rest and opens only with the secret", () => {
  const key: Hex = `0x${"ab".repeat(32)}`;
  const sealed = sealKey(key, SECRET);
  assert.notEqual(sealed, key);
  assert.ok(!sealed.includes("abab"), "no key bytes in the clear");
  assert.equal(openKey(sealed, SECRET), key);
  assert.throws(() => openKey(sealed, "another-secret-of-thirty-two-characters!"));
});

test("/start makes a wallet, funds it from the faucet, and shows the card; a second /start keeps it", async () => {
  const { store, chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  const wallet = await store.get("7");
  assert.ok(wallet, "a wallet was made");
  assert.equal(chain.calls[0], `faucet ${parseEther("0.02")}`);
  assert.equal(await chain.ethBalance(wallet.address), parseEther("0.02"));
  assert.match(telegram.texts()[0]!, /made you a wallet/);
  assert.match(telegram.texts()[0]!, /topped it up with 0.02 test ETH/);
  const card = telegram.last();
  assert.match(card, new RegExp(wallet.address));
  assert.match(card, /0.02 ETH/);
  assert.match(card, /testnet playground: this key is ours/, "the card says who holds the key");
  assert.equal(openKey(wallet.sealedKey, SECRET).length, 66);

  await bot.handle(dm("/start"));
  assert.equal((await store.get("7"))!.address, wallet.address, "same wallet");
  assert.equal(chain.calls.filter((c) => c.startsWith("faucet")).length, 1, "no second faucet");
  assert.match(telegram.texts().at(-2)!, /welcome back/);
});

test("buy: a preset button quotes, guards slippage, lands, and reports the hash and the tokens", async () => {
  const { chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap("buy"));
  assert.match(telegram.last(), /buy FLEET/);
  await bot.handle(tap("buy:0.005"));
  const expectedMin = (parseEther("0.005") * 1000n * 9700n) / 10000n;
  assert.equal(chain.calls.at(-1), `buy ${parseEther("0.005")} min ${expectedMin}`, "3% under the spot quote");
  assert.match(telegram.last(), /✅ bought <code>4\.95 FLEET<\/code> for <code>0\.005 ETH<\/code>/);
  assert.match(telegram.last(), /tx <code>0x0+2<\/code>/);

  await bot.handle(dm("/buy 0.5"));
  assert.match(telegram.last(), /keep it under 0.05 ETH/);
  await bot.handle(dm("/buy abc"));
  assert.match(telegram.last(), /an amount like 0.002/);
  await bot.handle(dm("/buy 0.019"));
  assert.match(telegram.last(), /not enough/, "the balance minus gas is checked first");
  chain.failNextTrade();
  await bot.handle(dm("/buy 0.001"));
  assert.match(telegram.last(), /the buy reverted/);
});

test("sell: a share of what is held, quoted and guarded; nothing to sell says so", async () => {
  const { chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap("sell"));
  assert.match(telegram.last(), /nothing to sell/);
  await bot.handle(dm("/buy 0.01"));
  await bot.handle(tap("sell:50"));
  const held = parseEther("0.01") * 990n;
  const half = held / 2n;
  assert.equal(chain.calls.at(-1), `sell ${half} min ${((half / 1000n) * 9700n) / 10000n}`);
  assert.match(telegram.last(), /✅ sold <code>4\.95 FLEET<\/code>/);
  assert.match(telegram.last(), /tx <code>0x/);
  await bot.handle(dm("/sell 150"));
  assert.match(telegram.last(), /a percentage/);
});

test("positions and withdraw read the chain and move test ETH only where the user says", async () => {
  const { chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(dm("/buy 0.002"));
  await bot.handle(tap("positions"));
  assert.match(telegram.last(), /FLEET: <code>1\.98<\/code>/);
  assert.match(telegram.last(), /≈ <code>0\.00198 ETH<\/code> at spot/);
  await bot.handle(dm("/withdraw nope 0.01"));
  assert.match(telegram.last(), /\/withdraw 0xAddress 0.01/);
  await bot.handle(dm("/withdraw 0x00000000000000000000000000000000000000ee 0.01"));
  assert.equal(chain.calls.at(-1), `send ${parseEther("0.01")} to 0x00000000000000000000000000000000000000ee`);
  assert.match(telegram.last(), /✅ sent <code>0\.01 ETH<\/code>/);
  await bot.handle(dm("/withdraw 0x00000000000000000000000000000000000000ee 5"));
  assert.match(telegram.last(), /leave a little for gas/);
});

test("the faucet is once a day; the group is sent to private except for /pool", async () => {
  const { chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(dm("/faucet"));
  assert.match(telegram.last(), /once a day per wallet/);
  clock = new Date("2026-09-17T11:00:00Z");
  await bot.handle(dm("/faucet"));
  assert.match(telegram.last(), /sent 0.02 test ETH/);
  assert.equal(chain.calls.filter((c) => c.startsWith("faucet")).length, 2);

  await bot.handle(group("/buy 0.01"));
  assert.match(telegram.last(), /open the bot/);
  assert.match(telegram.last(), /t\.me\/chit_playground_bot\?start=go/);
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, 0, "no trade from a group");
  await bot.handle(group("/pool"));
  assert.match(telegram.last(), /holds <code>0\.1465 ETH<\/code>/);
  await bot.handle(group("gm everyone"));
  assert.match(telegram.last(), /holds <code>0\.1465 ETH<\/code>/, "chatter gets no reply");
});

test("a failure on the chain becomes a message, never a crash", async () => {
  const { chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  chain.ethBalance = async () => { throw new Error("rpc down\nand a stack"); };
  await bot.handle(tap("home"));
  assert.match(telegram.last(), /something broke on our side: <code>rpc down<\/code>/);
});
