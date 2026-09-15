import assert from "node:assert/strict";
import test from "node:test";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { BotChain, TokenInfo } from "../../src/fleet/bot-chain.js";
import { ChitBot, type Update } from "../../src/fleet/bot-handlers.js";
import { RecordingTelegram, type Keyboard } from "../../src/fleet/bot-telegram.js";
import { MemoryBotWalletStore, openKey, refCodeOf, sealKey } from "../../src/fleet/bot-wallets.js";
import type { Address, Hex } from "../../src/fleet/types.js";

/**
 * Chit Bot's whole conversation, buttons and reply prompts, against a chain
 * of maps: Start makes and funds a wallet; a token card from a pasted
 * address; buys and sells from buttons and from typed replies, quoted and
 * guarded; settings that change the buttons; confirm and sell protection;
 * withdraw through a prompt; referral links; the group sent to private; the
 * faucet once a day; the playground key sealed at rest; a chain failure as
 * a message.
 */

const SECRET = "a-secret-long-enough-to-seal-keys-with-1234";
const FAUCET = "0x00000000000000000000000000000000000000fa" as Address;
const FLEET = "0x0000000000000000000000000000000000000fee" as Address;
const PEPE = "0x00000000000000000000000000000000000000ce" as Address;
const NOPOOL = "0x00000000000000000000000000000000000000dd" as Address;

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
  const chain: BotChain & { calls: string[]; failNextTrade: () => void } = {
    chainId: 46630, defaultToken: FLEET, router: "0x0000000000000000000000000000000000000001" as Address,
    calls,
    failNextTrade: () => { failNext = true; },
    ethBalance: async (a) => getE(a),
    tokenBalance: async (t, a) => getT(t, a),
    tokenInfo: async (t) => infos[t.toLowerCase()] ?? { address: t, symbol: "?", decimals: 18, hasPool: false, perEth: 0n, poolEth: 0n },
    quoteBuy: async (t, wei) => (rate(t) ? (wei * rate(t)) / 10n ** 18n : null),
    quoteSell: async (t, units) => (rate(t) ? (units * 10n ** 18n) / rate(t) : null),
    async buy(k, t, ethIn, minOut) {
      const a = privateKeyToAccount(k).address;
      calls.push(`buy ${t} ${ethIn} min ${minOut}`);
      if (failNext) { failNext = false; return { hash: hash(), ok: false }; }
      setE(a, getE(a) - ethIn - 1000n);
      setT(t, a, getT(t, a) + ((ethIn * rate(t)) / 10n ** 18n * 99n) / 100n);
      return { hash: hash(), ok: true };
    },
    async sell(k, t, units, minOut) {
      const a = privateKeyToAccount(k).address;
      calls.push(`sell ${t} ${units} min ${minOut}`);
      setT(t, a, getT(t, a) - units);
      setE(a, getE(a) + ((units * 10n ** 18n) / rate(t) * 99n) / 100n - 1000n);
      return { hash: hash(), ok: true };
    },
    async send(k, to, wei) {
      const a = privateKeyToAccount(k).address;
      calls.push(`send ${wei} to ${to}`);
      setE(a, getE(a) - wei - 1000n);
      setE(to, getE(to) + wei);
      return { hash: hash(), ok: true };
    },
    async deposit(k, wei) {
      const a = privateKeyToAccount(k).address;
      calls.push(`deposit ${wei}`);
      setE(a, getE(a) - wei - 1000n);
      return { hash: hash(), ok: true };
    },
    async faucet(to, wei) {
      calls.push(`faucet ${wei}`);
      setE(FAUCET, getE(FAUCET) - wei);
      setE(to, getE(to) + wei);
      return { hash: hash(), ok: true };
    },
    faucetBalance: async () => getE(FAUCET),
    poolNumbers: async () => ({ address: "0x0000000000000000000000000000000000000900" as Address, heldWei: parseEther("0.1465"), totalDeposited: parseEther("0.15"), campaigns: 3n, paused: false }),
  };
  return chain;
};

const dm = (text: string, from = 7, replyTo?: string): Update => ({
  message: { message_id: 1, text, chat: { id: from, type: "private" }, from: { id: from, first_name: "Lucian" }, ...(replyTo ? { reply_to_message: { text: replyTo } } : {}) },
});
const group = (text: string): Update => ({ message: { message_id: 1, text, chat: { id: -100, type: "supergroup" }, from: { id: 7 } } });
const tap = (data: string, from = 7): Update => ({ callback_query: { id: "cb", data, from: { id: from }, message: { message_id: 9, chat: { id: from, type: "private" } } } });

let clock = new Date("2026-09-16T10:00:00Z");
const setup = () => {
  const store = new MemoryBotWalletStore();
  const chain = fakeChain();
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

test("the playground key is sealed at rest and opens only with the secret", () => {
  const key: Hex = `0x${"ab".repeat(32)}`;
  const sealed = sealKey(key, SECRET);
  assert.notEqual(sealed, key);
  assert.ok(!sealed.includes("abab"), "no key bytes in the clear");
  assert.equal(openKey(sealed, SECRET), key);
  assert.throws(() => openKey(sealed, "another-secret-of-thirty-two-characters!"));
});

test("Start makes a wallet, funds it, shows the card with the buttons; a second Start keeps it", async () => {
  const { store, chain, telegram, bot, buttons } = setup();
  await bot.handle(dm("/start"));
  const wallet = await store.get("7");
  assert.ok(wallet, "a wallet was made");
  assert.equal(chain.calls[0], `faucet ${parseEther("0.02")}`);
  assert.match(telegram.texts()[0]!, /made you a wallet/);
  const card = telegram.last();
  assert.match(card, new RegExp(wallet.address));
  assert.match(card, /0.02 ETH/);
  assert.match(card, /testnet playground: this key is ours/, "the card says who holds the key");
  assert.deepEqual(buttons(), ["buy:", "sell:", "positions", "fleet", "sessions", "refer", "settings", "withdraw", "help", "home"]);
  assert.equal(openKey(wallet.sealedKey, SECRET).length, 66);
  assert.equal(wallet.refCode, refCodeOf("7", SECRET));

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
  assert.deepEqual(buttons().slice(0, 3), [`b:${PEPE}:0.001`, `b:${PEPE}:0.005`, `b:${PEPE}:0.01`]);
  assert.ok(buttons().includes(`ask:buy:${PEPE}`) && buttons().includes(`s:${PEPE}:25`));
  assert.deepEqual((await store.get("7"))!.tokens, [PEPE], "the token is remembered");
  await bot.handle(dm(NOPOOL));
  assert.match(telegram.last(), /no ETH pool on the venue/);
});

test("a preset button buys with the quote and the guard; a custom amount comes through the reply field", async () => {
  const { chain, telegram, bot, prompt } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap(`b:${FLEET}:0.005`));
  const expectedMin = (parseEther("0.005") * 1000n * 9700n) / 10000n;
  assert.equal(chain.calls.at(-1), `buy ${FLEET} ${parseEther("0.005")} min ${expectedMin}`, "3% under the pool quote");
  assert.match(telegram.last(), /✅ bought <code>4\.95 FLEET<\/code> for <code>0\.005 ETH<\/code>/);
  assert.match(telegram.last(), /tx <code>0x0+2<\/code>/);

  await bot.handle(tap(`ask:buy:${PEPE}`));
  assert.equal(prompt(), "how much ETH to spend?", "the reply field opened");
  await bot.handle(dm("0.002", 7, "how much ETH to spend?"));
  assert.match(chain.calls.at(-1)!, new RegExp(`^buy ${PEPE} ${parseEther("0.002")}`));
  assert.match(telegram.last(), /✅ bought <code>1980 PEPE<\/code>/);

  await bot.handle(tap(`b:${FLEET}:0.5`));
  assert.match(telegram.last(), /keep it under 0.05 ETH/);
  await bot.handle(dm("abc", 7, "how much ETH to spend?"));
  assert.match(telegram.last(), /an amount like 0.002/);
  await bot.handle(tap(`b:${FLEET}:0.019`));
  assert.match(telegram.last(), /not enough/, "the balance minus gas is checked first");
  chain.failNextTrade();
  await bot.handle(tap(`b:${FLEET}:0.001`));
  assert.match(telegram.last(), /the buy reverted/);
});

test("sell buttons sell a share; sell protection and confirm trades ask first", async () => {
  const { chain, telegram, bot, buttons } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap("sell:"));
  assert.match(telegram.last(), /nothing to sell yet/);
  await bot.handle(tap(`b:${FLEET}:0.01`));
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

  // Confirm trades on: every buy asks first, and the card's buttons carry the confirming form.
  await bot.handle(tap("set:confirmTrades"));
  assert.match(telegram.last(), /🟢 confirm trades: on/);
  await bot.handle(tap(`token:${FLEET}`));
  assert.ok(buttons().includes(`bc:${FLEET}:0.001`));
  await bot.handle(tap(`b:${FLEET}:0.001`));
  assert.match(telegram.last(), /buy <code>0\.001 ETH<\/code> of FLEET\?/);
  const buys = chain.calls.filter((c) => c.startsWith("buy")).length;
  await bot.handle(tap(`bc:${FLEET}:0.001`));
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, buys + 1);
});

test("settings change the presets and the slippage through the reply field, and reset", async () => {
  const { store, telegram, bot, buttons, chain } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap("settings"));
  assert.match(telegram.last(), /buy amounts: <code>0\.001 · 0\.005 · 0\.01 ETH<\/code>/);
  await bot.handle(tap("set:buyPresets"));
  await bot.handle(dm("0.002 0.02 0.04", 7, "your three buy amounts in ETH, like: 0.001 0.005 0.01"));
  assert.deepEqual((await store.get("7"))!.settings.buyPresets, ["0.002", "0.02", "0.04"]);
  await bot.handle(dm("1 2", 7, "your three buy amounts in ETH, like: 0.001 0.005 0.01"));
  assert.match(telegram.last(), /three amounts in ETH/);
  await bot.handle(tap("set:buySlippage"));
  await bot.handle(dm("10", 7, "buy slippage in percent, 0.5 to 20"));
  assert.equal((await store.get("7"))!.settings.buySlippageBps, 1000);
  await bot.handle(tap(`b:${FLEET}:0.002`));
  assert.match(chain.calls.at(-1)!, /min 1800000000000000000$/, "10% under 2 FLEET");
  await bot.handle(tap(`token:${FLEET}`));
  assert.deepEqual(buttons().slice(0, 3), [`b:${FLEET}:0.002`, `b:${FLEET}:0.02`, `b:${FLEET}:0.04`], "the card wears the new presets");
  await bot.handle(tap("set:reset"));
  assert.deepEqual((await store.get("7"))!.settings.buyPresets, ["0.001", "0.005", "0.01"]);
});

test("positions list holdings with what they would fetch; withdraw goes through the address prompt and amount buttons", async () => {
  const { chain, telegram, bot, buttons, prompt } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap(`b:${FLEET}:0.002`));
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
  const half = buttons()[0]!;
  assert.match(half, new RegExp(`^w:${to}:`));
  await bot.handle(tap(half));
  assert.match(chain.calls.at(-1)!, new RegExp(`^send \\d+ to ${to}$`));
  assert.match(telegram.last(), /✅ sent/);
  await bot.handle(tap(`ask:wto:${to}`));
  await bot.handle(dm("5", 7, "how much ETH to send?"));
  assert.match(telegram.last(), /leave a little for gas/);
});

test("referral links count, cannot point at yourself, and promise nothing", async () => {
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
  await bot.handle(dm(`/start r-${code}`, 7));
  assert.equal((await store.get("7"))!.referredBy, null, "you cannot refer yourself");
});

test("the faucet is once a day; the group is sent to private except for /pool; two taps do not race", async () => {
  const { chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  await bot.handle(tap("faucet"));
  assert.match(telegram.last(), /once a day per wallet/);
  clock = new Date("2026-09-17T11:00:00Z");
  await bot.handle(tap("faucet"));
  assert.match(telegram.last(), /sent <code>0.02 test ETH<\/code>/);
  assert.equal(chain.calls.filter((c) => c.startsWith("faucet")).length, 2);

  await bot.handle(group("/buy"));
  assert.match(telegram.last(), /open the bot/);
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, 0, "no trade from a group");
  await bot.handle(group("/pool"));
  assert.match(telegram.last(), /holds <code>0\.1465 ETH<\/code>/);
  await bot.handle(group("gm everyone"));
  assert.match(telegram.last(), /holds <code>0\.1465 ETH<\/code>/, "chatter gets no reply");

  // Two buys at once: the second is told to wait, and only one lands.
  const slowBuy = chain.buy;
  chain.buy = async (...args) => { await new Promise((r) => setTimeout(r, 20)); return slowBuy(...args); };
  await Promise.all([bot.handle(tap(`b:${FLEET}:0.001`)), bot.handle(tap(`b:${FLEET}:0.001`))]);
  assert.equal(chain.calls.filter((c) => c.startsWith("buy")).length, 1);
  assert.ok(telegram.texts().some((t) => /one trade at a time/.test(t)));
});

test("a failure on the chain becomes a message, never a crash", async () => {
  const { chain, telegram, bot } = setup();
  await bot.handle(dm("/start"));
  chain.ethBalance = async () => { throw new Error("rpc down\nand a stack"); };
  await bot.handle(tap("home"));
  assert.match(telegram.last(), /something broke on our side: <code>rpc down<\/code>/);
});

import { recoverMessageAddress } from "viem";
import type { FleetApi } from "../../src/fleet/bot-fleet.js";

/** The hosted service, faked: canned answers, and every signed action's envelope checked to recover to the wallet. */
const fakeFleetApi = (walletOf: () => Address) => {
  const calls: Array<{ route: string; action: string; body: unknown; key?: string }> = [];
  const accounts = ["0x1000000000000000000000000000000000000001", "0x1000000000000000000000000000000000000002", "0x1000000000000000000000000000000000000003", "0x1000000000000000000000000000000000000004", "0x1000000000000000000000000000000000000005"] as Address[];
  let state = "Created";
  const api: FleetApi & { calls: typeof calls; setState: (s: string) => void } = {
    calls,
    setState: (s) => { state = s; },
    async call(route, payload, key) {
      const { action, body, auth } = payload as { action: string; body: Record<string, unknown>; auth?: Record<string, string> };
      calls.push({ route, action, body, ...(key ? { key } : {}) });
      if (action === "quote") return { status: 200, body: { quoteId: "q1", eligible: true, netFee: "0" } };
      if (action === "challenge") return { status: 200, body: { challenge: `chit challenge for ${body["action"]} ${body["payloadHash"]}`, nonce: "n1", issuedAt: "2026-09-16T10:00:00.000Z", expiresAt: "2026-09-16T10:10:00.000Z" } };
      if (action === "status") return { status: 200, body: { campaign: body["campaign"], state, accounts, budget: { funded: "20000000000000000", spent: "1000000000000000", unused: "19000000000000000" } } };
      // Everything else is signed: the envelope must be the wallet's, over the challenge text.
      if (!auth) return { status: 401, body: { code: "challenge_invalid" } };
      const expected = `chit challenge for ${action} ${auth["payloadHash"]}`;
      const signer = await recoverMessageAddress({ message: expected, signature: auth["signature"] as Hex });
      if (signer.toLowerCase() !== walletOf().toLowerCase() || auth["action"] !== action) return { status: 401, body: { code: "challenge_invalid" } };
      if (["create", "activate", "buy", "pause", "close", "confirmRecovery"].includes(action) && !key?.startsWith("fleet-")) return { status: 409, body: { code: "idempotency_conflict" } };
      switch (action) {
        case "create": {
          const b = body as { accounts: unknown[]; policy: { accounts: number }; recoveryVaultCommitment: string };
          if (b.accounts.length !== 5 || b.policy.accounts !== 5 || !/^0x[0-9a-f]{64}$/.test(b.recoveryVaultCommitment)) return { status: 422, body: { code: "policy_rejected" } };
          return { status: 200, body: { campaign: "camp-1", state: "Awaiting recovery confirmation", budget: {} } };
        }
        case "confirmRecovery": return { status: 200, body: { campaign: "camp-1", state: "Created", budget: {} } };
        case "activate": state = "Activating"; return { status: 200, body: { campaign: "camp-1", state, accounts, budget: {} } };
        case "buy": return { status: 200, body: { results: accounts.map((a, i) => ({ account: a, status: i === 4 ? "rejected" : "sponsored", txHash: `0x${"ab".repeat(32)}`, ...(i === 4 ? { reason: "policy_rejected" } : {}) })) } };
        case "pause": state = "Paused"; return { status: 200, body: { campaign: "camp-1", state, budget: {} } };
        case "resume": state = "Active"; return { status: 200, body: { campaign: "camp-1", state, budget: {} } };
        case "close": state = "Closed"; return { status: 200, body: { campaign: "camp-1", state, budget: { unused: "19000000000000000" } } };
        case "balance": return { status: 200, body: { available: "30000000000000000", deposited: "50000000000000000", spent: "0", openDraws: "20000000000000000" } };
        default: return { status: 409, body: { code: "state_invalid" } };
      }
    },
  };
  return api;
};

test("the fleet from the chat: deposit, create with sealed keys, activate, buy from five wallets, pause, close, all signed by the playground key", async () => {
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
  assert.ok(buttons().includes("fl:dep:0.01") && buttons().includes("fl:create"));

  await bot.handle(tap("fl:dep:0.01"));
  assert.equal(chain.calls.at(-1), `deposit ${parseEther("0.01")}`);
  assert.ok(telegram.texts().some((t) => /✅ deposited <code>0\.01 ETH<\/code> into the pool/.test(t)));

  await bot.handle(tap("fl:create"));
  const create = fleetApi.calls.find((c) => c.action === "create")!;
  assert.ok(create, "create was sent");
  const body = create.body as { accounts: Array<{ ownerAddress: string; salt: string }>; policy: { router: string; function: string; maxTradeValue: string } };
  assert.equal(body.accounts.length, 5);
  assert.ok(body.accounts.every((a) => /^0x[0-9a-f]{40}$/.test(a.ownerAddress) && /^0x[0-9a-f]{64}$/.test(a.salt)), "addresses and salts, no keys");
  assert.ok(!JSON.stringify(create.body).includes("sealedKey"), "no sealed key crosses to the service");
  assert.equal(body.policy.function, "execute(bytes,bytes[],uint256)");
  assert.ok(fleetApi.calls.some((c) => c.action === "confirmRecovery"));
  const saved = (await store.get("7"))!.fleet!;
  assert.equal(saved.campaign, "camp-1");
  assert.equal(saved.accounts.length, 5);
  assert.equal(openKey(saved.accounts[0]!.sealedKey, SECRET).length, 66, "the fleet keys are sealed like the wallet's");
  assert.match(telegram.last(), /created and confirmed\. activate it/);
  assert.ok(buttons().includes("fl:act:0.02"));

  await bot.handle(tap("fl:act:0.02"));
  const act = fleetApi.calls.find((c) => c.action === "activate")!;
  assert.deepEqual(act.body, { campaign: "camp-1", draw: parseEther("0.02").toString() });
  assert.equal((await store.get("7"))!.fleet!.fleet.length, 5, "the fleet wallets came back with the activation");
  assert.match(telegram.last(), /activating: the draw is open/);

  fleetApi.setState("Active");
  await bot.handle(tap("fl:status"));
  assert.ok(telegram.texts().some((t) => /<b>Active<\/b> · draw <code>0\.02 ETH<\/code>/.test(t)));
  assert.ok(buttons().includes("fl:buy:0.0005"));

  await bot.handle(tap("fl:buy:0.0005"));
  const buy = fleetApi.calls.find((c) => c.action === "buy")!;
  assert.equal(buy.route, "buy");
  assert.deepEqual((buy.body as { accounts: string[] }).accounts.length, 5);
  assert.ok(telegram.texts().some((t) => /bought from <b>4<\/b> of 5 wallets/.test(t)));

  await bot.handle(tap("fl:pause"));
  assert.equal(fleetApi.calls.at(-1)!.route, "control");
  assert.ok(buttons().includes("fl:resume"));
  await bot.handle(tap("fl:close"));
  assert.ok(telegram.texts().some((t) => /✅ close: <b>Closed<\/b>\. the unspent draw is back/.test(t)));
  assert.ok(buttons().includes("fl:create"), "a closed fleet offers a new one");

  await bot.handle(tap("fl:bal"));
  assert.match(telegram.last(), /available <code>0\.03 ETH<\/code> · in open fleets <code>0\.02<\/code>/);

  // Every signed call carried an envelope the fake recovered to this wallet; a tampered signer is refused.
  const signed = fleetApi.calls.filter((c) => !["quote", "challenge", "status"].includes(c.action));
  assert.ok(signed.length >= 7, `signed actions: ${signed.map((c) => c.action).join(",")}`);
  walletAddr = "0x00000000000000000000000000000000000000ff";
  await bot.handle(tap("fl:bal"));
  assert.match(telegram.last(), /the service said <code>challenge_invalid<\/code> \(401\)/);
});
