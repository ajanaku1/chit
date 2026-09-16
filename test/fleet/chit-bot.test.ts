import assert from "node:assert/strict";
import test from "node:test";
import { parseEther, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { BotChain, TokenInfo } from "../../src/fleet/bot-chain.js";
import { BRIDGE_ORIGINS, createRelayBridge, type BotBridge } from "../../src/fleet/bot-bridge.js";
import { fleetPhase, type FleetApi } from "../../src/fleet/bot-fleet.js";
import { ChitBot, type Update } from "../../src/fleet/bot-handlers.js";
import { RecordingTelegram, type Keyboard } from "../../src/fleet/bot-telegram.js";
import { MemoryBotWalletStore, RefCodeTaken, SealError, checkCanary, open, openKey, refCodeOf, seal, sealCanary, sealKey, walletAad, type BotWallet, type BotWalletStore } from "../../src/fleet/bot-wallets.js";
import { payloadHash } from "../../src/fleet/campaign-service.js";
import type { Address, Hex } from "../../src/fleet/types.js";

/**
 * Chit Bot's whole conversation, buttons and reply prompts, against a chain
 * of maps: Start makes and funds a wallet; a token card from a pasted
 * address; buys and sells from buttons and from typed replies, quoted and
 * guarded; settings that change the buttons; confirm and sell protection
 * applied by the handler whatever the button; withdraw through a prompt;
 * referral links; the group sent to private; the faucet once a day and
 * within a budget; the playground key sealed at rest and bound to its row;
 * a redelivered update ignored; two instances sharing one store; a chain
 * failure as a message; the fleet journey against a fake service that
 * checks every signature and every payload hash.
 */

const SECRET = "a-secret-long-enough-to-seal-keys-with-1234";
const FAUCET = "0x00000000000000000000000000000000000000fa" as Address;
const FLEET = "0x0000000000000000000000000000000000000fee" as Address;
const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const NOPOOL = "0x00000000000000000000000000000000000000dd" as Address;
const POOL = "0x0000000000000000000000000000000000000900" as Address;
const wei = (s: string): string => parseEther(s).toString();

/** Balances per (token, address); prices per token; a faucet with a balance. */
const fakeChain = () => {
  const eth = new Map<string, bigint>([[FAUCET, parseEther("1")]]);
  const tokens = new Map<string, bigint>();
  const calls: string[] = [];
  const key = (t: string, a: string) => `${t.toLowerCase()}:${a.toLowerCase()}`;
  const getE = (a: string) => eth.get(a.toLowerCase()) ?? 0n;
  const setE = (a: string, v: bigint) => eth.set(a.toLowerCase(), v);
  const getT = (t: string, a: string) => tokens.get(key(t, a)) ?? 0n;
  const setT = (t: string, a: string, v: bigint) => tokens.set(key(t, a), v);
  const infos: Record<string, TokenInfo> = {
    [FLEET.toLowerCase()]: { address: FLEET, symbol: "FLEET", decimals: 18, hasPool: true, perEth: parseEther("1000"), poolEth: parseEther("0.02") },
    [PEPE.toLowerCase()]: { address: PEPE, symbol: "PEPE", decimals: 6, hasPool: true, perEth: 1_000_000_000_000n, poolEth: parseEther("5") },
    [NOPOOL.toLowerCase()]: { address: NOPOOL, symbol: "NOPE", decimals: 18, hasPool: false, perEth: 0n, poolEth: 0n },
  };
  const rate = (t: string) => (infos[t.toLowerCase()]?.perEth ?? 0n);
  let n = 0;
  const hash = (): Hex => `0x${(++n).toString(16).padStart(64, "0")}`;
  let failNext = false;
  let pendNext = false;
  const chain: BotChain & { calls: string[]; failNextTrade: () => void; pendNextTrade: () => void } = {
    chainId: 46630, defaultToken: FLEET, router: "0x0000000000000000000000000000000000000001" as Address, pool: POOL, hasFaucet: true,
    calls,
    failNextTrade: () => { failNext = true; },
    pendNextTrade: () => { pendNext = true; },
    ethBalance: async (a) => getE(a),
    tokenBalance: async (t, a) => getT(t, a),
    tokenInfo: async (t) => infos[t.toLowerCase()] ?? { address: t, symbol: "?", decimals: 18, hasPool: false, perEth: 0n, poolEth: 0n },
    quoteBuy: async (t, w) => (rate(t) ? (w * rate(t)) / 10n ** 18n : null),
    quoteSell: async (t, units) => (rate(t) ? (units * 10n ** 18n) / rate(t) : null),
    async buy(k, t, ethIn, minOut) {
      const a = privateKeyToAccount(k).address;
      calls.push(`buy ${t} ${ethIn} min ${minOut}`);
      if (failNext) { failNext = false; return { hash: hash(), ok: false }; }
      setE(a, getE(a) - ethIn - 1000n);
      setT(t, a, getT(t, a) + ((ethIn * rate(t)) / 10n ** 18n * 99n) / 100n);
      if (pendNext) { pendNext = false; return { hash: hash(), ok: false, pending: true }; }
      return { hash: hash(), ok: true };
    },
    async sell(k, t, units, minOut) {
      const a = privateKeyToAccount(k).address;
      calls.push(`sell ${t} ${units} min ${minOut}`);
      setT(t, a, getT(t, a) - units);
      setE(a, getE(a) + ((units * 10n ** 18n) / rate(t) * 99n) / 100n - 1000n);
      return { hash: hash(), ok: true };
    },
    async send(k, to, w) {
      const a = privateKeyToAccount(k).address;
      calls.push(`send ${w} to ${to}`);
      setE(a, getE(a) - w - 1000n);
      setE(to, getE(to) + w);
      return { hash: hash(), ok: true };
    },
    async deposit(k, w) {
      const a = privateKeyToAccount(k).address;
      calls.push(`deposit ${w}`);
      setE(a, getE(a) - w - 1000n);
      return { hash: hash(), ok: true };
    },
    async faucet(to, w) {
      calls.push(`faucet ${w}`);
      setE(FAUCET, getE(FAUCET) - w);
      setE(to, getE(to) + w);
      return { hash: hash(), ok: true };
    },
    faucetBalance: async () => getE(FAUCET),
    poolNumbers: async () => ({ address: POOL, heldWei: parseEther("0.1465"), totalDeposited: parseEther("0.15"), campaigns: 3n, paused: false }),
    newPools: async () => [
      { token: PEPE, block: 1_000_050n, tradeable: true, fee: 3000, hooks: "0x0000000000000000000000000000000000000000" as Address },
      { token: NOPOOL, block: 1_000_020n, tradeable: false, fee: 0, hooks: "0x2779651feE12F6fB5A187578De6b63709f85d0Cc" as Address },
      { token: FLEET, block: 999_000n, tradeable: true, fee: 3000, hooks: "0x0000000000000000000000000000000000000000" as Address },
    ],
  };
  return chain;
};

const dm = (text: string, from = 7, replyTo?: string, updateId?: number): Update => ({
  ...(updateId !== undefined ? { update_id: updateId } : {}),
  message: { message_id: 1, text, chat: { id: from, type: "private" }, from: { id: from, first_name: "Lucian" }, ...(replyTo ? { reply_to_message: { text: replyTo } } : {}) },
});
const group = (text: string): Update => ({ message: { message_id: 1, text, chat: { id: -100, type: "supergroup" }, from: { id: 7 } } });
const tap = (data: string, from = 7, updateId?: number, callbackId = "cb"): Update => ({
  ...(updateId !== undefined ? { update_id: updateId } : {}),
  callback_query: { id: callbackId, data, from: { id: from }, message: { message_id: 9, chat: { id: from, type: "private" } } },
});

let clock = new Date("2026-09-16T10:00:00Z");
const setup = (shared?: { store?: BotWalletStore; chain?: ReturnType<typeof fakeChain> }) => {
  const store = shared?.store ?? new MemoryBotWalletStore();
  const chain = shared?.chain ?? fakeChain();
  const telegram = new RecordingTelegram();
  const bot = new ChitBot({ store, chain, telegram, keySecret: SECRET, botUsername: "chit_playground_bot", now: () => clock });
  /** The last message's keyboard, flattened to callback data. */
  const buttons = (): string[] => {
    const last = [...telegram.sent].reverse().find((o) => o.kind !== "answer") as { keyboard?: Keyboard } | undefined;
    return (last?.keyboard ?? []).flat().map((b) => ("callback_data" in b ? b.callback_data : b.url));
  };
  /** The last prompt's text, when the bot opened the reply field. */
  const prompt = (): string | undefined => {
    const last = [...telegram.sent].reverse().find((o) => o.kind === "send") as { ask?: string; text: string } | undefined;
    return last?.ask ? last.text : undefined;
  };
  return { store, chain, telegram, bot, buttons, prompt };
};

test("the playground key is sealed at rest, bound to its row, and opens only with the secret", () => {
  const key: Hex = `0x${"ab".repeat(32)}`;
  const sealed = sealKey(key, SECRET, walletAad("7"));
  assert.match(sealed, /^v2\./);
  const bytes = Buffer.from(sealed.slice(3), "base64");
  assert.equal(bytes.indexOf(Buffer.from("ab".repeat(32), "hex")), -1, "no key bytes in the clear, checked on the decoded bytes");
  assert.equal(openKey(sealed, SECRET, walletAad("7")), key);
  assert.throws(() => openKey(sealed, "another-secret-of-thirty-two-characters!", walletAad("7")), (e: unknown) => e instanceof SealError && e.code === "secret_mismatch", "a different secret is named as such");
  assert.throws(() => openKey(sealed, SECRET, walletAad("8")), (e: unknown) => e instanceof SealError && e.code === "tampered", "the same blob under another Telegram id does not open");
  assert.throws(() => openKey(Buffer.from("abc").toString("base64"), SECRET, walletAad("7")), (e: unknown) => e instanceof SealError && e.code === "format");
  assert.notEqual(sealKey(key, SECRET, walletAad("7")), sealed, "a fresh iv every time");
  assert.equal(open(seal(Buffer.from("hi"), SECRET, "x"), SECRET, "x").toString(), "hi");
  assert.equal(checkCanary(sealCanary(SECRET), SECRET), true);
  assert.throws(() => checkCanary(sealCanary(SECRET), "another-secret-of-thirty-two-characters!"));
});

test("Start makes a wallet, funds it, shows the card with the buttons; a second Start keeps it", async () => {
  const { store, chain, telegram, bot, buttons } = setup();
  await bot.handle(dm("/start"));
  const wallet = await store.get("7");
  assert.ok(wallet, "a wallet was made");
  assert.equal(chain.calls[0], `faucet ${parseEther("0.02")}`);
  assert.match(telegram.texts()[0]!, /made you a wallet/);
  assert.match(telegram.texts()[0]!, /next and not live/, "mainnet is not described as live");
  const card = telegram.last();
  assert.match(card, new RegExp(wallet.address));
  assert.match(card, /0.02 ETH/);
  assert.match(card, /testnet playground: this key is ours/, "the card says who holds the key");
  assert.deepEqual(buttons(), ["buy:", "sell:", "positions", "new", "fleet", "sessions", "refer", "settings", "withdraw", "faucet", "help", "home"]);
  assert.equal(openKey(wallet.sealedKey, SECRET, walletAad("7")).length, 66);
  assert.equal(wallet.refCode, refCodeOf("7", SECRET));
  assert.ok(wallet.faucetAt, "the faucet stamp was claimed");

  await bot.handle(dm("/start"));
  assert.equal((await store.get("7"))!.address, wallet.address, "same wallet");
  assert.equal(chain.calls.filter((c) => c.startsWith("faucet")).length, 1, "no second faucet");
  await bot.handle(dm("hello?"));
  assert.match(telegram.last(), /Robinhood Chain testnet/, "any other text redraws the card");
});

test("a pasted contract address opens the token card with the user's buy and sell buttons; no pool says so", async () => {
  const { bot, telegram, buttons, store } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(dm(`check this ${PEPE} lol`));
  assert.match(telegram.last(), /<b>PEPE<\/b>/);
  assert.match(telegram.last(), /1000000 PEPE<\/code> per ETH/, "six-decimal token priced right");
  assert.match(telegram.last(), /pool: <code>5 ETH<\/code>/);
  assert.deepEqual(buttons().slice(0, 3), [`b:${PEPE}:${wei("0.001")}`, `b:${PEPE}:${wei("0.005")}`, `b:${PEPE}:${wei("0.01")}`], "amounts travel as wei");
  assert.ok(buttons().includes(`ask:buy:${PEPE}`) && buttons().includes(`s:${PEPE}:25`));
  assert.deepEqual((await store.get("7"))!.tokens, [PEPE], "the token is remembered");
  await bot.handle(dm(NOPOOL));
  assert.match(telegram.last(), /no ETH pool on the venue/);
});

test("a preset button buys with the quote and the guard; a custom amount comes through a reply prompt that names the token", async () => {
  const { chain, telegram, bot, prompt } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap(`b:${FLEET}:${wei("0.005")}`));
  const expectedMin = (parseEther("0.005") * 1000n * 9700n) / 10000n;
  assert.equal(chain.calls.at(-1), `buy ${FLEET} ${parseEther("0.005")} min ${expectedMin}`, "3% under the pool quote");
  assert.match(telegram.last(), /✅ bought <code>4\.95 FLEET<\/code> for <code>0\.005 ETH<\/code>/);
  assert.match(telegram.last(), /tx <code>0x0+2<\/code>/);

  await bot.handle(tap(`ask:buy:${PEPE}`));
  assert.equal(prompt(), `how much ETH to spend on PEPE?\n${PEPE}`, "the reply field opened, and the prompt carries the token");
  await bot.handle(dm("0.002", 7, prompt()));
  assert.match(chain.calls.at(-1)!, new RegExp(`^buy ${PEPE} ${parseEther("0.002")}`));
  assert.match(telegram.last(), /✅ bought <code>1980 PEPE<\/code>/);

  // A prompt that lost its token (an old bot's text) trades nothing.
  const buys = chain.calls.filter((c) => c.startsWith("buy")).length;
  await bot.handle(dm("0.002", 7, "how much ETH to spend on PEPE?"));
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, buys, "no trade on a guess");
  assert.match(telegram.last(), /lost its token/);

  await bot.handle(tap(`b:${FLEET}:${wei("0.5")}`));
  assert.match(telegram.last(), /keep it under 0.05 ETH/);
  await bot.handle(dm("abc", 7, `how much ETH to spend on FLEET?\n${FLEET}`));
  assert.match(telegram.last(), /an amount like 0.002/);
  await bot.handle(tap(`b:${FLEET}:${wei("0.019")}`));
  assert.match(telegram.last(), /not enough/, "the balance minus gas is checked first");
  assert.ok(telegram.sent.at(-1)!.kind === "send" && JSON.stringify((telegram.sent.at(-1) as { keyboard?: Keyboard }).keyboard).includes("faucet"), "the faucet is offered");
  chain.failNextTrade();
  await bot.handle(tap(`b:${FLEET}:${wei("0.001")}`));
  assert.match(telegram.last(), /the buy reverted/);
});

test("a transaction without a receipt in time is reported with its hash, never sent twice", async () => {
  const { chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  chain.pendNextTrade();
  await bot.handle(tap(`b:${FLEET}:${wei("0.001")}`));
  assert.match(telegram.last(), /still landing after a while: <code>0x0+2<\/code>\. do not tap again/);
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, 1);
});

test("sell buttons sell a share; sell protection and confirm trades are applied by the handler whatever button was pressed", async () => {
  const { chain, telegram, bot, buttons } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap("sell:"));
  assert.match(telegram.last(), /nothing to sell yet/);
  await bot.handle(tap(`b:${FLEET}:${wei("0.01")}`));
  const held = (parseEther("0.01") * 1000n * 99n) / 100n;
  await bot.handle(tap(`s:${FLEET}:50`));
  const half = held / 2n;
  assert.equal(chain.calls.at(-1), `sell ${FLEET} ${half} min ${((half / 1000n) * 9700n) / 10000n}`);
  assert.match(telegram.last(), /✅ sold <code>4\.95 FLEET<\/code>/);

  // Sell protection: over 75% asks first, then the confirm button sells.
  await bot.handle(tap(`s:${FLEET}:100`));
  assert.match(telegram.last(), /sell protection: that is most of the position/);
  assert.deepEqual(buttons(), [`sc:${FLEET}:100`, `token:${FLEET}`]);
  const sells = chain.calls.filter((c) => c.startsWith("sell")).length;
  await bot.handle(tap(`sc:${FLEET}:100`));
  assert.equal(chain.calls.filter((c) => c.startsWith("sell")).length, sells + 1);

  // Positions' own Sell 100% goes through the same protection: its button is the plain verb.
  await bot.handle(tap(`b:${FLEET}:${wei("0.01")}`));
  await bot.handle(tap("positions"));
  assert.ok(buttons().includes(`s:${FLEET}:100`), "no confirmed verb on a card button");
  await bot.handle(tap(`s:${FLEET}:100`));
  assert.match(telegram.last(), /sell protection/);

  // Confirm trades on: the card's buttons stay plain, and every buy asks first.
  await bot.handle(tap("set:confirmTrades"));
  assert.match(telegram.last(), /🟢 confirm trades: on/);
  await bot.handle(tap(`token:${FLEET}`));
  assert.ok(buttons().includes(`b:${FLEET}:${wei("0.001")}`), "the card never carries the confirmed verb");
  assert.match(telegram.last(), /every trade asks first/);
  await bot.handle(tap(`b:${FLEET}:${wei("0.001")}`));
  assert.match(telegram.last(), /buy <code>0\.001 ETH<\/code> of FLEET\?/);
  assert.deepEqual(buttons(), [`bc:${FLEET}:${wei("0.001")}`, `token:${FLEET}`]);
  const buys = chain.calls.filter((c) => c.startsWith("buy")).length;
  await bot.handle(tap(`bc:${FLEET}:${wei("0.001")}`));
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, buys + 1);
});

test("settings change the presets and the slippage through the reply field, bound the presets, and reset", async () => {
  const { store, telegram, bot, buttons, chain } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap("settings"));
  assert.match(telegram.last(), /buy amounts: <code>0\.001 · 0\.005 · 0\.01 ETH<\/code>/);
  await bot.handle(tap("set:buyPresets"));
  await bot.handle(dm("0.002 0.02 0.04", 7, "your three buy amounts in ETH, like: 0.001 0.005 0.01"));
  assert.deepEqual((await store.get("7"))!.settings.buyPresets, ["0.002", "0.02", "0.04"]);
  await bot.handle(dm("1 2", 7, "your three buy amounts in ETH, like: 0.001 0.005 0.01"));
  assert.match(telegram.last(), /three amounts in ETH/);
  await bot.handle(dm("0.00100000001 0.02 0.04", 7, "your three buy amounts in ETH, like: 0.001 0.005 0.01"));
  assert.match(telegram.last(), /at most 10 characters/, "a preset that would not fit a button is refused");
  await bot.handle(tap("set:buySlippage"));
  await bot.handle(dm("10", 7, "buy slippage in percent, 0.5 to 20"));
  assert.equal((await store.get("7"))!.settings.buySlippageBps, 1000);
  await bot.handle(tap(`b:${FLEET}:${wei("0.002")}`));
  assert.match(chain.calls.at(-1)!, /min 1800000000000000000$/, "10% under 2 FLEET");
  await bot.handle(tap(`token:${FLEET}`));
  assert.deepEqual(buttons().slice(0, 3), [`b:${FLEET}:${wei("0.002")}`, `b:${FLEET}:${wei("0.02")}`, `b:${FLEET}:${wei("0.04")}`], "the card wears the new presets");
  await bot.handle(tap("set:reset"));
  assert.deepEqual((await store.get("7"))!.settings.buyPresets, ["0.001", "0.005", "0.01"]);
});

test("positions list holdings with what they would fetch; withdraw goes through the address prompt, share buttons, and an amount prompt naming the address", async () => {
  const { chain, telegram, bot, buttons, prompt } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap(`b:${FLEET}:${wei("0.002")}`));
  await bot.handle(tap("positions"));
  assert.match(telegram.last(), /FLEET: <code>1\.98<\/code> ≈ <code>0\.00198 ETH<\/code> if sold now/);
  assert.ok(buttons().includes(`s:${FLEET}:50`));

  await bot.handle(tap("withdraw"));
  assert.equal(prompt(), "paste the address the test ETH goes to");
  await bot.handle(dm("nope", 7, "paste the address the test ETH goes to"));
  assert.match(telegram.last(), /not an address/);
  const to = "0x00000000000000000000000000000000000000ee";
  await bot.handle(dm(to, 7, "paste the address the test ETH goes to"));
  assert.match(telegram.last(), /pick or type an amount/);
  assert.deepEqual(buttons().slice(0, 2), [`w:h:${to}`, `w:a:${to}`], "the share buttons carry the address, not an amount");
  await bot.handle(tap(`w:h:${to}`));
  assert.match(chain.calls.at(-1)!, new RegExp(`^send \\d+ to ${to}$`));
  assert.match(telegram.last(), /✅ sent/);
  await bot.handle(tap(`ask:wto:${to}`));
  const amountPrompt = prompt();
  assert.equal(amountPrompt, `how much ETH to send?\nto ${to}`);
  await bot.handle(dm("5", 7, amountPrompt));
  assert.match(telegram.last(), /leave a little for gas/);
  await bot.handle(dm("0.001", 7, amountPrompt));
  assert.equal(chain.calls.at(-1), `send ${parseEther("0.001")} to ${to}`);
});

test("referral links count, cannot point at yourself, survive a code collision, and promise nothing", async () => {
  const { store, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  const code = (await store.get("7"))!.refCode;
  await bot.handle(dm(`/start r-${code}`, 8));
  assert.equal((await store.get("8"))!.referredBy, code);
  await bot.handle(dm(`/start r-${code}`, 9));
  await bot.handle(dm(`/start r-nope`, 10));
  assert.equal((await store.get("10"))!.referredBy, null, "an unknown code is ignored");
  await bot.handle(tap("refer"));
  assert.match(telegram.last(), /people who came through it: <code>2<\/code>/);
  assert.match(telegram.last(), /rewards: none yet, and we say so/);
  // A newcomer arriving on their own code (the guard's real case) is not credited to themselves.
  const own = refCodeOf("11", SECRET);
  await bot.handle(dm(`/start r-${own}`, 11));
  assert.equal((await store.get("11"))!.referredBy, null, "you cannot refer yourself");
  await bot.handle(dm(`/start r-${code}`, 7));
  assert.equal((await store.get("7"))!.referredBy, null, "an existing wallet is not re-attributed");

  // A referral code already taken: the store refuses once, the next code is used.
  let refused = false;
  const taken = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "create") return async (w: BotWallet) => { if (!refused) { refused = true; throw new RefCodeTaken(); } return target.create(w); };
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as BotWalletStore;
  const other = new ChitBot({ store: taken, chain: fakeChain(), telegram: new RecordingTelegram(), keySecret: SECRET, botUsername: "b", now: () => clock });
  await other.handle(dm("/start", 12));
  assert.equal((await store.get("12"))!.refCode, refCodeOf("12", SECRET, 1));
});

test("the faucet is once a day and within a daily budget; the group is sent to private except for /pool; two taps do not race", async () => {
  const { chain, telegram, bot, store } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap("faucet"));
  assert.match(telegram.last(), /once a day per wallet/);
  clock = new Date("2026-09-17T11:00:00Z");
  await bot.handle(tap("faucet"));
  assert.match(telegram.last(), /sent <code>0.02 test ETH<\/code>/);
  assert.equal(chain.calls.filter((c) => c.startsWith("faucet")).length, 2);

  // A burst of taps on the day after: the stamp is claimed once, one send.
  clock = new Date("2026-09-18T12:00:00Z");
  const before = chain.calls.filter((c) => c.startsWith("faucet")).length;
  await Promise.all([bot.handle(tap("faucet")), bot.handle(tap("faucet")), bot.handle(tap("faucet"))]);
  assert.equal(chain.calls.filter((c) => c.startsWith("faucet")).length, before + 1, "three taps, one payout");

  // The day's budget across everyone: a bot with a 0.03 budget pays one wallet, not two.
  const capped = new ChitBot({ store: new MemoryBotWalletStore(), chain, telegram, keySecret: SECRET, botUsername: "b", faucetDailyWei: parseEther("0.03"), now: () => clock });
  const n = chain.calls.filter((c) => c.startsWith("faucet")).length;
  await capped.handle(dm("/start", 21));
  await capped.handle(dm("/start", 22));
  assert.equal(chain.calls.filter((c) => c.startsWith("faucet")).length, n + 1, "the second wallet waits for tomorrow");
  assert.match(telegram.texts().at(-2)!, /daily budget/);

  await bot.handle(group("/start"));
  assert.match(telegram.last(), /open the bot/);
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, 0, "no trade from a group");
  const quiet = telegram.sent.length;
  for (const other of ["/raid https://x.com/x", "/report", "/stop", "/aiban", "/buy"]) await bot.handle(group(other));
  assert.equal(telegram.sent.length, quiet, "other bots' commands in the group get no answer at all");
  await bot.handle(group("/pool"));
  assert.match(telegram.last(), /holds <code>0\.1465 ETH<\/code>/);
  assert.match(telegram.last(), /3 draws opened/, "campaignCount is draws, not fleets funded");
  const sent = telegram.sent.length;
  await bot.handle(group("/pool@some_other_bot"));
  assert.equal(telegram.sent.length, sent, "another bot's command is left alone");
  await bot.handle(group("/pool@chit_playground_bot"));
  assert.match(telegram.last(), /holds <code>0\.1465 ETH<\/code>/, "ours is answered");
  await bot.handle(group("gm everyone"));
  assert.match(telegram.last(), /holds <code>0\.1465 ETH<\/code>/, "chatter gets no reply");

  // Two buys at once: the second meets the wallet's lock, and only one lands.
  const slowBuy = chain.buy;
  chain.buy = async (...args) => { await new Promise((r) => setTimeout(r, 20)); return slowBuy(...args); };
  await Promise.all([bot.handle(tap(`b:${FLEET}:${wei("0.001")}`)), bot.handle(tap(`b:${FLEET}:${wei("0.001")}`))]);
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, 1);
  assert.ok(telegram.texts().some((t) => /one thing at a time/.test(t)));
  assert.equal(await store.lock("wallet:7", clock, 1000), true, "the lock was released");
});

test("a Telegram update delivered twice is acted on once", async () => {
  const { chain, bot } = setup();
  await bot.handle(dm("/start", 7, undefined, 100));
  await bot.handle(tap(`b:${FLEET}:${wei("0.001")}`, 7, 101));
  await bot.handle(tap(`b:${FLEET}:${wei("0.001")}`, 7, 101));
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, 1, "the redelivery bought nothing");
  await bot.handle(tap(`b:${FLEET}:${wei("0.001")}`, 7, 102));
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, 2, "a new update is new");
});

test("two function instances over one store: a prompt asked on one is answered on the other, and money is serialised across both", async () => {
  const store = new MemoryBotWalletStore();
  const chain = fakeChain();
  const a = setup({ store, chain });
  const b = setup({ store, chain });
  await a.bot.handle(dm("/start"));
  await a.bot.handle(tap(`ask:buy:${PEPE}`));
  await b.bot.handle(dm("0.002", 7, a.prompt()));
  assert.match(chain.calls.at(-1)!, new RegExp(`^buy ${PEPE} ${parseEther("0.002")}`), "the token came from the prompt, not from instance memory");

  const slowBuy = chain.buy;
  chain.buy = async (...args) => { await new Promise((r) => setTimeout(r, 20)); return slowBuy(...args); };
  const buys = chain.calls.filter((c) => c.startsWith("buy")).length;
  await Promise.all([a.bot.handle(tap(`b:${FLEET}:${wei("0.001")}`)), b.bot.handle(tap(`b:${FLEET}:${wei("0.001")}`))]);
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, buys + 1, "the lock lives in the store, not the instance");
});

test("a failure on the chain becomes a message with the chain's words; an internal failure a plain line, never a crash or a detail", async () => {
  const { chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  chain.ethBalance = async () => { throw new Error("postgres://user:pw@host/db failed\nand a stack"); };
  await bot.handle(tap("home"));
  assert.match(telegram.last(), /something broke on our side\. try again in a moment\./);
  assert.doesNotMatch(telegram.last(), /postgres/, "internal detail stays in the log");
  chain.ethBalance = async () => { throw Object.assign(new Error("HTTP request failed.\n\nURL: x"), { shortMessage: "HTTP request failed." }); };
  await bot.handle(tap("home"));
  assert.match(telegram.last(), /the chain said: <code>HTTP request failed\.<\/code>/);
});

test("a rotated sealing secret stops the bot with a clear line instead of making wallets nobody can open", async () => {
  const store = new MemoryBotWalletStore();
  const first = setup({ store });
  await first.bot.handle(dm("/start"));
  const rotated = new ChitBot({ store, chain: first.chain, telegram: first.telegram, keySecret: "a-different-secret-of-thirty-two-plus-chars!", botUsername: "b", now: () => clock });
  const buys = first.chain.calls.filter((c) => c.startsWith("buy")).length;
  await rotated.handle(tap(`b:${FLEET}:${wei("0.001")}`));
  assert.match(first.telegram.last(), /being repaired: its sealing secret does not match/);
  assert.equal(first.chain.calls.filter((c) => c.startsWith("buy")).length, buys);
  assert.ok(await store.get("7"), "the wallet is untouched");
});

// ---------- the fleet from the chat ----------

/** The hosted service, faked: canned answers, every signed action's envelope recovered to the wallet, every payload hash recomputed. */
const fakeFleetApi = (walletOf: () => Address) => {
  const calls: Array<{ route: string; action: string; body: unknown; key?: string }> = [];
  const accounts = ["0x1000000000000000000000000000000000000001", "0x1000000000000000000000000000000000000002", "0x1000000000000000000000000000000000000003", "0x1000000000000000000000000000000000000004", "0x1000000000000000000000000000000000000005"] as Address[];
  let state = "Awaiting funding";
  let available = parseEther("0.03");
  const draw = { amount: "0", spent: "0", remaining: "0", dueAt: "2026-09-16T10:12:00.000Z", state: "Pending" };
  const api: FleetApi & { calls: typeof calls; setState: (s: string) => void; setAvailable: (w: bigint) => void; failActivate: boolean } = {
    calls,
    failActivate: false,
    setState: (s) => { state = s; if (s === "Active") draw.state = "Funded"; },
    setAvailable: (w) => { available = w; },
    async call(route, payload, key) {
      const { action, body, auth } = payload as { action: string; body: Record<string, unknown>; auth?: Record<string, string> };
      calls.push({ route, action, body, ...(key ? { key } : {}) });
      if (action === "quote") return { status: 200, body: { quoteId: "q1", eligible: true, netFee: "0" } };
      if (action === "challenge") return { status: 200, body: { challenge: `chit challenge for ${body["action"]} ${body["payloadHash"]}`, nonce: "n1", issuedAt: "2026-09-16T10:00:00.000Z", expiresAt: "2026-09-16T10:10:00.000Z" } };
      // The real status route: the state read from the chain and the draw; no budget, no accounts.
      if (action === "status") return { status: 200, body: { campaign: body["campaign"], state, draw } };
      // Everything else is signed: the envelope must be the wallet's, over the challenge text, and the hash must be the body's.
      if (!auth) return { status: 401, body: { code: "challenge_invalid" } };
      if (auth["payloadHash"] !== payloadHash(body)) return { status: 401, body: { code: "payload_hash_mismatch" } };
      const expected = `chit challenge for ${action} ${auth["payloadHash"]}`;
      const signer = await recoverMessageAddress({ message: expected, signature: auth["signature"] as Hex });
      if (signer.toLowerCase() !== walletOf().toLowerCase() || auth["action"] !== action) return { status: 401, body: { code: "challenge_invalid" } };
      if (["create", "confirmRecovery", "activate", "buy", "pause", "resume", "close"].includes(action) && !key?.startsWith("fleet-bot-")) return { status: 409, body: { code: "idempotency_conflict" } };
      switch (action) {
        case "create": {
          const b = body as { accounts: unknown[]; policy: { accounts: number }; recoveryVaultCommitment: string };
          if (b.accounts.length !== 5 || b.policy.accounts !== 5 || !/^0x[0-9a-f]{64}$/.test(b.recoveryVaultCommitment)) return { status: 422, body: { code: "policy_rejected" } };
          return { status: 200, body: { campaign: "camp-1", state: "Awaiting recovery confirmation", budget: {} } };
        }
        case "confirmRecovery": return { status: 200, body: { campaign: "camp-1", state: "Awaiting funding", budget: {} } };
        case "activate": {
          if (api.failActivate) return { status: 409, body: { code: "insufficient_balance" } };
          const amount = BigInt(String(body["draw"]));
          if (amount > available) return { status: 409, body: { code: "insufficient_balance" } };
          state = "Activating"; draw.amount = amount.toString(); draw.remaining = amount.toString(); available -= amount;
          return { status: 200, body: { campaign: "camp-1", state, accounts, draw, budget: {} } };
        }
        case "buy": return { status: 200, body: { results: accounts.map((a, i) => ({ account: a, status: i === 4 ? "rejected" : "sponsored", txHash: `0x${"ab".repeat(32)}`, ...(i === 4 ? { reason: "policy_rejected" } : {}) })) } };
        case "pause": state = "Paused"; return { status: 200, body: { campaign: "camp-1", state, budget: {} } };
        case "resume": state = "Active"; return { status: 200, body: { campaign: "camp-1", state, budget: {} } };
        case "close": state = "Closed"; draw.state = "Closed"; available += BigInt(draw.remaining); return { status: 200, body: { campaign: "camp-1", state, budget: { unused: "19000000000000000" } } };
        case "balance": return { status: 200, body: { available: available.toString(), deposited: "50000000000000000", spent: "0", openDraws: draw.state === "Closed" ? "0" : draw.amount } };
        default: return { status: 409, body: { code: "state_invalid" } };
      }
    },
  };
  return api;
};

test("fleet phases follow the service's state names", () => {
  const rec = (state: string) => ({ campaign: "c", accounts: [], fleet: [], vaultCommitment: "0x" as Hex, createdAt: "", state });
  assert.equal(fleetPhase(undefined), "none");
  assert.equal(fleetPhase(rec("Awaiting recovery confirmation")), "created");
  assert.equal(fleetPhase(rec("Awaiting funding")), "created", "the activate step is next, not running");
  assert.equal(fleetPhase(rec("Activating")), "activating");
  assert.equal(fleetPhase(rec("Active")), "active");
  assert.equal(fleetPhase(rec("Paused")), "paused");
  for (const s of ["Revoked", "Depleted", "Expired"]) assert.equal(fleetPhase(rec(s)), "ended", `${s} is over, close is what is left`);
  assert.equal(fleetPhase(rec("Closed")), "closed");
});

test("the fleet from the chat: deposit, create and activate in one tap, buy from five wallets, pause, close, all signed by the playground key and hashed over the real body", async () => {
  const store = new MemoryBotWalletStore();
  const chain = fakeChain();
  const telegram = new RecordingTelegram();
  let walletAddr: Address = "0x0000000000000000000000000000000000000000";
  const fleetApi = fakeFleetApi(() => walletAddr);
  const bot = new ChitBot({ store, chain, telegram, fleetApi, keySecret: SECRET, botUsername: "chit_playground_bot", now: () => clock });
  const buttons = (): string[] => {
    const last = [...telegram.sent].reverse().find((o) => o.kind !== "answer") as { keyboard?: Keyboard } | undefined;
    return (last?.keyboard ?? []).flat().map((b) => ("callback_data" in b ? b.callback_data : b.url));
  };
  await bot.handle(dm("/start"));
  walletAddr = (await store.get("7"))!.address;

  await bot.handle(tap("fleet"));
  assert.match(telegram.last(), /step 1: put ETH in the pool/);
  assert.match(telegram.last(), /the operator can link them, and says so\. private, not anonymous/, "FR-015, no further");
  assert.doesNotMatch(telegram.last(), /the chain cannot|nothing links/);
  assert.ok(buttons().includes(`fl:dep:${wei("0.01")}`) && buttons().includes("fl:new"));

  await bot.handle(tap(`fl:dep:${wei("0.01")}`));
  assert.equal(chain.calls.at(-1), `deposit ${parseEther("0.01")}`);
  assert.ok(telegram.texts().some((t) => /✅ deposited <code>0\.01 ETH<\/code> into the pool/.test(t)));

  // The draw menu offers only what the pool balance covers.
  await bot.handle(tap("fl:new"));
  assert.deepEqual(buttons().filter((b) => b.startsWith("fl:go:")), [`fl:go:${wei("0.005")}`, `fl:go:${wei("0.01")}`, `fl:go:${wei("0.02")}`]);
  fleetApi.setAvailable(parseEther("0.006"));
  await bot.handle(tap("fl:new"));
  assert.deepEqual(buttons().filter((b) => b.startsWith("fl:go:")), [`fl:go:${wei("0.005")}`], "0.01 and 0.02 do not fit 0.006");
  fleetApi.setAvailable(parseEther("0.0005"));
  await bot.handle(tap("fl:new"));
  assert.match(telegram.last(), /deposit first/);
  fleetApi.setAvailable(parseEther("0.03"));

  await bot.handle(tap(`fl:go:${wei("0.005")}`, 7, undefined, "cb-go-1"));
  const create = fleetApi.calls.find((c) => c.action === "create")!;
  assert.ok(create, "create was sent");
  const body = create.body as { accounts: Array<{ ownerAddress: string; salt: string }>; policy: { router: string; function: string; maxTradeValue: string } };
  assert.equal(body.accounts.length, 5);
  assert.ok(body.accounts.every((a) => /^0x[0-9a-f]{40}$/.test(a.ownerAddress) && /^0x[0-9a-f]{64}$/.test(a.salt)), "addresses and salts, no keys");
  assert.ok(!JSON.stringify(create.body).includes("sealedKey"), "no sealed key crosses to the service");
  assert.equal(body.policy.function, "execute(bytes,bytes[],uint256)");
  assert.equal(create.key, "fleet-bot-create-cb-go-1", "the idempotency key is the tap's, not the clock's");
  assert.ok(fleetApi.calls.some((c) => c.action === "confirmRecovery"));
  const act = fleetApi.calls.find((c) => c.action === "activate")!;
  assert.deepEqual(act.body, { campaign: "camp-1", draw: parseEther("0.005").toString() });
  assert.equal(act.key, "fleet-bot-activate-cb-go-1");
  const stored = (await store.get("7"))!;
  assert.ok(stored.fleet?.startsWith("v2."), "the fleet record is sealed as one blob");
  assert.ok(!stored.fleet!.includes("camp-1"), "nothing about the fleet is readable from a dump");
  assert.match(telegram.last(), /activating: the draw is open/);
  assert.match(telegram.texts().join("\n"), /✅ activated with a draw of <code>0\.005 ETH<\/code>/);

  // A setting changed now does not erase the fleet: writes are per column.
  await bot.handle(tap("set:confirmTrades"));
  assert.ok((await store.get("7"))!.fleet, "the fleet survived a settings write");
  await bot.handle(tap("set:confirmTrades"));

  // A second create while a draw is open is refused.
  await bot.handle(tap(`fl:go:${wei("0.005")}`, 7, undefined, "cb-go-2"));
  assert.match(telegram.texts().join("\n"), /you already have a fleet <code>camp-1<\/code>/);
  assert.equal(fleetApi.calls.filter((c) => c.action === "create").length, 1);
  await bot.handle(tap("fl:drop"));
  assert.match(telegram.last(), /has a draw open; close it instead/);

  fleetApi.setState("Active");
  await bot.handle(tap("fl:status"));
  assert.ok(telegram.texts().some((t) => /<b>Active<\/b> · draw <code>0\.005 ETH<\/code>, spent <code>0<\/code>, remaining <code>0\.005<\/code>/.test(t)), "the status card reads the draw the real route returns");
  assert.ok(buttons().includes(`fl:buy:${wei("0.0005")}`));

  await bot.handle(tap(`fl:buy:${wei("0.0005")}`, 7, undefined, "cb-buy"));
  const buy = fleetApi.calls.find((c) => c.action === "buy")!;
  assert.equal(buy.route, "buy");
  assert.equal((buy.body as { accounts: string[] }).accounts.length, 5);
  assert.equal(buy.key, "fleet-bot-buy-cb-buy");
  assert.ok(telegram.texts().some((t) => /bought from <b>4<\/b> of 5 wallets/.test(t)));

  await bot.handle(tap("fl:pause"));
  assert.equal(fleetApi.calls.at(-1)!.route, "control");
  assert.ok(buttons().includes("fl:resume"));
  await bot.handle(tap("fl:close"));
  assert.ok(telegram.texts().some((t) => /✅ close: <b>Closed<\/b>\. the unspent draw is back/.test(t)));
  assert.ok(buttons().includes("fl:new"), "a closed fleet offers a new one");

  await bot.handle(tap("fl:bal"));
  assert.match(telegram.last(), /available <code>0\.03 ETH<\/code> · in open fleets <code>0<\/code>/);

  // Every signed call carried an envelope the fake recovered to this wallet and a hash of the body it got; a tampered signer is refused.
  const signed = fleetApi.calls.filter((c) => !["quote", "challenge", "status"].includes(c.action));
  assert.ok(signed.length >= 7, `signed actions: ${signed.map((c) => c.action).join(",")}`);
  walletAddr = "0x00000000000000000000000000000000000000ff";
  await bot.handle(tap("fl:bal"));
  assert.match(telegram.last(), /the service said <code>challenge_invalid<\/code> \(401\)/);
});

test("a fleet created but not activated offers activate and start over; an ended fleet offers close", async () => {
  const store = new MemoryBotWalletStore();
  const chain = fakeChain();
  const telegram = new RecordingTelegram();
  let walletAddr: Address = "0x0000000000000000000000000000000000000000";
  const fleetApi = fakeFleetApi(() => walletAddr);
  const bot = new ChitBot({ store, chain, telegram, fleetApi, keySecret: SECRET, botUsername: "b", now: () => clock });
  const buttons = (): string[] => {
    const last = [...telegram.sent].reverse().find((o) => o.kind !== "answer") as { keyboard?: Keyboard } | undefined;
    return (last?.keyboard ?? []).flat().map((b) => ("callback_data" in b ? b.callback_data : b.url));
  };
  await bot.handle(dm("/start"));
  walletAddr = (await store.get("7"))!.address;
  fleetApi.failActivate = true;
  await bot.handle(tap(`fl:go:${wei("0.005")}`));
  assert.match(telegram.texts().join("\n"), /created, but activating failed: the service said <code>insufficient_balance<\/code>/);
  assert.match(telegram.last(), /created, not activated yet/);
  assert.deepEqual(buttons().slice(0, 2), ["fl:new", "fl:drop"]);

  // Activate later: no second create.
  fleetApi.failActivate = false;
  await bot.handle(tap(`fl:go:${wei("0.005")}`));
  assert.equal(fleetApi.calls.filter((c) => c.action === "create").length, 1, "the existing fleet is activated, not replaced");
  assert.match(telegram.last(), /activating: the draw is open/);

  // Expired: the card offers close, and nothing else that would fail.
  fleetApi.setState("Expired");
  await bot.handle(tap("fl:status"));
  assert.match(telegram.last(), /Expired: this fleet is done; close returns the unspent draw/);
  assert.deepEqual(buttons().slice(0, 2), ["fl:close", "fl:status"]);

  // Start over is for un-activated fleets only; after a close it is not needed.
  await bot.handle(tap("fl:close"));
  await bot.handle(tap("fl:drop"));
  assert.match(telegram.texts().join("\n"), /forgotten/);
  assert.equal((await store.get("7"))!.fleet, undefined);
});

test("banner cards: a photo with the text as caption, swapped in place for another banner card, and a text card after it comes fresh", async () => {
  const store = new MemoryBotWalletStore();
  const chain = fakeChain();
  const telegram = new RecordingTelegram();
  const banners = { home: "https://chit.tools/bot/home.png", refer: "/tmp/refer.png", buy: "https://chit.tools/bot/buy.png" };
  const bot = new ChitBot({ store, chain, telegram, keySecret: SECRET, botUsername: "b", banners, now: () => clock });
  await bot.handle(dm("/start"));
  const home = telegram.sent.at(-1)!;
  assert.equal(home.kind, "photo");
  assert.equal((home as { photo: string }).photo, banners.home);
  assert.match((home as { text: string }).text, /Robinhood Chain testnet/);

  // A button under the banner card: the next banner card replaces photo and caption in place, a URL or a file path alike.
  const underBanner = (data: string): Update => ({ callback_query: { id: "cb", data, from: { id: 7 }, message: { message_id: 99, chat: { id: 7, type: "private" }, photo: [{}] } } });
  await bot.handle(underBanner("refer"));
  const refer = telegram.sent.at(-1)!;
  assert.equal(refer.kind, "editPhoto");
  assert.equal((refer as { photo: string; messageId: number }).photo, banners.refer);
  assert.equal((refer as { messageId: number }).messageId, 99);
  await bot.handle(underBanner("buy:"));
  assert.equal(telegram.sent.at(-1)!.kind, "editPhoto");

  // A plain card cannot replace a photo: it comes as a new message.
  await bot.handle(underBanner("settings"));
  assert.equal(telegram.sent.at(-1)!.kind, "send");
  assert.match(telegram.last(), /<b>settings<\/b>/);
  // And a banner card cannot replace a plain one: from a text message it comes as a new photo.
  await bot.handle(tap("home"));
  assert.equal(telegram.sent.at(-1)!.kind, "photo");
  // A card with no banner configured stays text.
  await bot.handle(tap("fleet"));
  assert.equal(telegram.sent.at(-1)!.kind, "edit");
});

test("the new tab lists what just opened on the venue, buy buttons only where this bot can trade; a t- deep link opens a token card", async () => {
  const { bot, telegram, buttons } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap("new"));
  assert.match(telegram.last(), /<b>new on the venue<\/b> · 3 ETH pools opened/);
  assert.match(telegram.last(), /<b>PEPE<\/b> · pool <code>5 ETH<\/code> · just now/);
  assert.match(telegram.last(), /<b>NOPE<\/b> · 30 blocks ago · <i>on a pool this bot cannot trade yet \(fee 0%, hooked\)<\/i>/);
  assert.deepEqual(buttons().filter((b) => b.startsWith("token:")), [`token:${PEPE}`, `token:${FLEET}`], "no buy button on the hooked pool");

  // A partner's button: t.me/<bot>?start=t-<contract>, straight to the card, wallet made on the way for a newcomer.
  await bot.handle(dm(`/start t-${PEPE}`, 42));
  assert.match(telegram.texts().at(-2)!, /made you a wallet/);
  assert.match(telegram.last(), /<b>PEPE<\/b> · <code>0x/);
  await bot.handle(dm(`/start t-${PEPE}`, 42));
  assert.match(telegram.last(), /<b>PEPE<\/b> · <code>0x/, "a returning user lands on the card too, no welcome line in between");
});

test("the bridge card shows only the routes Relay quotes right now, as links into Relay's app, and says it is mainnet", async () => {
  // Relay, faked: base quotes both, arbitrum only ETH, arc nothing (its first day), the rest refuse.
  const calls: string[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { originChainId: number; destinationCurrency: string };
    calls.push(`${body.originChainId}:${body.destinationCurrency.slice(0, 6)}`);
    const chit = body.destinationCurrency !== "0x0000000000000000000000000000000000000000";
    const ok = body.originChainId === 8453 || (body.originChainId === 42161 && !chit);
    return new Response(JSON.stringify(ok ? { steps: [] } : { errorCode: "NO_SWAP_ROUTES_FOUND" }), { status: 200 });
  }) as unknown as typeof fetch;
  const bridge: BotBridge = createRelayBridge(fakeFetch, 60_000);
  const store = new MemoryBotWalletStore();
  const telegram = new RecordingTelegram();
  const bot = new ChitBot({ store, chain: fakeChain(), telegram, bridge, keySecret: SECRET, botUsername: "b", now: () => clock });
  await bot.handle(dm("/start"));
  const last = telegram.sent.at(-1) as { keyboard?: Keyboard };
  assert.ok(last.keyboard!.flat().some((b) => "callback_data" in b && b.callback_data === "bridge"), "the home card offers the bridge");
  await bot.handle(tap("bridge"));
  assert.equal(calls.length, BRIDGE_ORIGINS.length * 2, "one ETH and one CHIT quote per origin");
  assert.match(telegram.last(), /<b>base<\/b> \(ETH\): ETH ✓ · CHIT ✓/);
  assert.match(telegram.last(), /<b>arbitrum<\/b> \(ETH\): ETH ✓ · CHIT ✖/);
  assert.match(telegram.last(), /no route right now from ethereum, optimism, bnb chain, polygon, solana, arc/);
  assert.match(telegram.last(), /mainnet, real money\. this playground is testnet/);
  const urls = ((telegram.sent.at(-1) as { keyboard?: Keyboard }).keyboard ?? []).flat().filter((b) => "url" in b).map((b) => (b as { url: string }).url);
  assert.deepEqual(urls, [
    "https://relay.link/bridge/robinhood?fromChainId=8453&fromCurrency=0x0000000000000000000000000000000000000000&toCurrency=0x0000000000000000000000000000000000000000",
    "https://relay.link/bridge/robinhood?fromChainId=8453&fromCurrency=0x0000000000000000000000000000000000000000&toCurrency=0xd523a627030509021cc39b6d7c8543417d3e50d8",
    "https://relay.link/bridge/robinhood?fromChainId=42161&fromCurrency=0x0000000000000000000000000000000000000000&toCurrency=0x0000000000000000000000000000000000000000",
  ]);
  // A second look inside the cache window asks Relay nothing.
  await bot.handle(tap("bridge"));
  assert.equal(calls.length, BRIDGE_ORIGINS.length * 2);
});
