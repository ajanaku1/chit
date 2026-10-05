/**
 * /bug and /board in the mainnet bot. A report is kept by Telegram id and
 * told to the operator chat under the reporter's nickname, never their
 * wallet; an empty /bug explains; the operator chat absent, the report is
 * still kept. /board is the site's board as a message, top five of each,
 * the unranked with their count; a route that does not answer is said.
 * Without the stores both are the help card, which names them only when
 * the competition is on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryBugStore, MemoryCompStore, NeonBugStore, boardText, bugReply, type BoardLike, type CompSql } from "../../src/fleet/bot-comp.js";
import { MemoryBotLinkStore } from "../../src/fleet/bot-link.js";
import { SessionBot } from "../../src/fleet/bot-session.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";
import type { BotChain } from "../../src/fleet/bot-chain.js";
import type { SessionChain } from "../../src/fleet/bot-session-chain.js";
import type { Update } from "../../src/fleet/bot-handlers.js";

const clock = new Date("2026-10-04T12:00:00Z");
const dm = (text: string, username?: string): Update => ({ message: { message_id: 1, text, chat: { id: 7, type: "private" }, from: { id: 7, ...(username ? { username } : {}) } } });
const board: BoardLike = {
  ended: false, end: "2026-10-09T12:00:00.000Z", entrants: 4, trades: 11, minTrades: 5,
  pnl: [{ nickname: "alpha", pct: 12.5, trades: 6, qualified: true }, { nickname: "b<b>", pct: 40, trades: 2, qualified: false }],
  ongoing: [{ nickname: "alpha", symbol: "PEPE", pct: 3 }],
};
type Deps = ConstructorParameters<typeof SessionBot>[0];
const setup = (extra: Partial<Deps> = {}) => {
  const telegram = new RecordingTelegram();
  const bot = new SessionBot({ reads: { chainId: 4663 } as unknown as BotChain, session: { chainId: 4663, signer: "0x00000000000000000000000000000000000000b0" } as unknown as SessionChain, links: new MemoryBotLinkStore(), telegram, botUsername: "usechit_bot", siteUrl: "https://app.chit.tools", now: () => clock, ...extra });
  const sent = () => telegram.sent.filter((o): o is Extract<typeof o, { kind: "send" }> => o.kind === "send");
  return { bot, telegram, sent };
};

test("/bug: kept by id, forwarded to the operator chat under the nickname; empty explains; no operator chat, still kept", async () => {
  const store = new MemoryBugStore(), comp = new MemoryCompStore();
  await comp.join({ tgId: "7", username: null, nickname: "alpha", joinedAt: clock.toISOString() });
  const { bot, sent } = setup({ comp, bugs: { store, operatorChatId: "-100999" } });
  await bot.handle(dm("/bug"));
  assert.match(sent().at(-1)!.text, /send \/bug and what happened/);
  assert.equal(store.reports.length, 0);
  await bot.handle(dm("/bug the sell button did nothing after I tapped 50%", "ogle"));
  assert.deepEqual(store.reports, [{ tgId: "7", text: "the sell button did nothing after I tapped 50%", at: clock.toISOString() }]);
  const [forward, reply] = sent().slice(-2);
  assert.equal(forward!.chatId, "-100999");
  assert.match(forward!.text, /bug from alpha \(tg 7, report 1\):\nthe sell button did nothing/);
  assert.match(reply!.text, /filed, thank you\. that is your first report/);
  const quiet = setup({ bugs: { store: new MemoryBugStore() } });
  await quiet.bot.handle(dm("/bug x", "ogle"));
  assert.deepEqual(quiet.sent().map((o) => o.chatId), ["7"], "no operator chat: the reporter alone is told");
  assert.match((await bugReply(new MemoryBugStore(), { tgId: "9" }, "y", undefined, clock)).forward!, /bug from tg 9/);
  assert.match((await bugReply(new MemoryBugStore(), { tgId: "9" }, "z".repeat(1501), undefined, clock)).reply, /over 1500 characters/);
});

test("the bug store on pglite keeps and counts by id", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    const store = new NeonBugStore({ query: async (q, p) => (await db.query(q, p)).rows as Record<string, unknown>[] } satisfies CompSql);
    await store.add({ tgId: "1", text: "a", at: clock.toISOString() });
    await store.add({ tgId: "1", text: "b", at: clock.toISOString() });
    await store.add({ tgId: "2", text: "c", at: clock.toISOString() });
    assert.deepEqual([await store.count("1"), await store.count("2"), await store.count("3")], [2, 1, 0]);
  } finally { await db.close(); }
});

test("/board: the standings as a message, names escaped, the unranked with their count, and a link to the page; a route that fails is said", async () => {
  const { bot, sent } = setup({ board: async () => board });
  await bot.handle(dm("/board"));
  const text = sent().at(-1)!.text;
  assert.match(text, /if it ended now/);
  assert.match(text, /4 in, 11 trades counted/);
  assert.match(text, /1\. alpha <code>\+12\.50%<\/code>\n2\. b&lt;b&gt; <code>\+40\.00%<\/code> \(2\/5 trades\)/);
  assert.match(text, /best open trade · \$350<\/b>\n1\. alpha <code>\+3\.00%<\/code> PEPE/);
  assert.match(text, /href="https:\/\/app\.chit\.tools\/app\/board"/);
  const down = setup({ board: async () => { throw new Error("502"); } });
  await down.bot.handle(dm("/board"));
  assert.match(down.sent().at(-1)!.text, /board is not answering.*app\/board/);
  const over = boardText({ ...board, ended: true, awards: [{ prize: "best pnl", usd: 500, nickname: "alpha" }] }, "x");
  assert.match(over, /competition over.*\n.*\n\n<b>winners<\/b>\n\$500 best pnl: <b>alpha<\/b>/);
});

test("without the stores, /bug and /board are the help card, and the help card names the commands only with the competition on", async () => {
  const plain = setup();
  await plain.bot.handle(dm("/bug x"));
  assert.doesNotMatch(plain.sent().at(-1)!.text, /filed|\/board/);
  const on = setup({ comp: new MemoryCompStore() });
  await on.bot.handle(dm("/help"));
  assert.match(on.sent().at(-1)!.text, /\/competition for how to enter.*\/board.*\/bug/);
});

test("/competition and the 🏆 button: the three steps in order, what this user has done ticked, the doors to the Sessions page and the board; no competition, the help card", async () => {
  const comp = new MemoryCompStore();
  const links = new MemoryBotLinkStore();
  const { bot, sent, telegram } = setup({ comp, links });
  const buttons = () => { const last = [...telegram.sent].reverse().find((o) => o.kind !== "answer") as { keyboard?: { callback_data?: string; url?: string }[][] } | undefined; return (last?.keyboard ?? []).flat().map((b) => b.callback_data ?? b.url ?? ""); };
  await bot.handle(dm("/start"));
  assert.ok(buttons().includes("comp"), "the home card has the Competition button");
  await bot.handle(dm("/competition"));
  let text = sent().at(-1)!.text;
  assert.match(text, /<b>trading competition<\/b> · 2 to 9 october, noon UTC · \$1,000 in USDG/);
  assert.match(text, /▫️ 1\. pick a nickname: <code>\/join yourname<\/code>\n▫️ 2\. link a session account.*\n▫️ 3\. trade from this bot/);
  assert.deepEqual(buttons(), ["joinhow", "https://app.chit.tools/app/sessions", "connect", "https://app.chit.tools/app/board", "home"]);
  await comp.join({ tgId: "7", username: null, nickname: "alpha", joinedAt: clock.toISOString() });
  await links.putLink({ tgId: "7", account: "0x00000000000000000000000000000000000000aa", owner: "0x0000000000000000000000000000000000000011", chainId: 4663, nonce: "n", signature: "0x00", linkedAt: clock.toISOString() });
  await bot.handle({ callback_query: { id: "cb", data: "comp", from: { id: 7 }, message: { message_id: 9, chat: { id: 7, type: "private" } } } });
  // A tap edits the card in place: the last outgoing that is not the tap's answer.
  text = telegram.last();
  assert.match(text, /✅ 1\. pick a nickname.*\(you're in as <b>alpha<\/b>\)\n✅ 2\. link a session account/);
  assert.deepEqual(buttons(), ["https://app.chit.tools/app/sessions", "https://app.chit.tools/app/board", "home"], "nothing left to do but trade: no Join, no Link");
  const plain = setup();
  await plain.bot.handle(dm("/competition"));
  assert.doesNotMatch(plain.sent().at(-1)!.text, /how to enter/);
  await plain.bot.handle(dm("/start"));
  assert.ok(!(await (async () => { const last = [...plain.telegram.sent].reverse().find((o) => o.kind !== "answer") as { keyboard?: { callback_data?: string }[][] } | undefined; return (last?.keyboard ?? []).flat().some((b) => b.callback_data === "comp"); })()), "no competition, no button");
});
