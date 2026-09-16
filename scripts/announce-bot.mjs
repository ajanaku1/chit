/**
 * Posts the daily invitation to try the bot in the group: one thing it does
 * (a different one each day), a button that opens the bot in private, and
 * the standing lines: beta, testnet, nothing real, ideas and bugs wanted.
 *
 * Runs from .github/workflows/announce-bot.yml. Needs TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID (the announcer's, as for the other posts) and the
 * repository variable BOT_USERNAME (the playground bot's @name without the
 * @); without the username it prints and exits 0, without the secrets it
 * prints. DATABASE_URL, when given, adds how many wallets exist, read from
 * the bot's own table over Neon's HTTP endpoint; without it the line is
 * left out rather than guessed.
 *
 * Plain node, no install. Lowercase, honest: nothing here is promised that
 * the bot does not do today (docs/chit-bot.md).
 */

const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const bot = (process.env.BOT_USERNAME ?? "").replace(/^@/, "");
const site = (process.env.FLEET_ORIGIN ?? "https://chit.tools").replace(/\/+$/, "");
const dbUrl = process.env.DATABASE_URL;

if (!bot) { console.log("BOT_USERNAME is not set: no bot to invite people to"); process.exit(0); }

/** One feature a day, in the order a newcomer meets them; the day of the year picks it. */
const TIPS = [
  "press start and you get a wallet on robinhood chain testnet, topped up with test eth by the faucet. no seed phrase, no setup, nothing to lose",
  "paste any token's contract address in the chat and its card appears: price, the pool's eth, what you hold, buy and sell buttons. any token with an eth pool on the venue",
  "buy with one tap. the quote comes from the pool with fee and price impact, your slippage guards it, and the reply carries the real transaction hash. every trade is a real tx through the real uniswap v4 router",
  "sell 25, 50 or 100 percent, or a custom share. the first sale approves the router once; sell protection asks before you dump most of a position",
  "positions shows everything you hold and what each would fetch if sold right now, fee and impact included, with sell buttons on the row",
  "settings are the ones that matter: your buy amounts, your sell shares, buy and sell slippage, confirm trades, sell protection. no priority fee toggles, no turbo mode, the chain has a sequencer and none of that exists here",
  "the fleet card runs chit's own product from the chat: deposit into the pool, create a fleet of five and activate it in one tap, buy from every wallet, pause, close. private, not anonymous, and the card says exactly that",
  "refer has your link and counts who came through it. rewards: none yet, and the card says so. when the fee goes live the roadmap's referral pays from it",
  "withdraw moves your test eth to any address you paste, half, all but gas, or an amount. faucet tops you up once a day",
];
const day = Math.floor(Date.now() / 86_400_000);
const tip = TIPS[day % TIPS.length];

/** How many playground wallets exist, from the bot's table; Neon's HTTP endpoint takes one statement per request. */
const walletCount = async () => {
  if (!dbUrl) return undefined;
  try {
    const host = new URL(dbUrl.replace(/^postgres(ql)?:/, "https:")).host;
    const r = await fetch(`https://${host}/sql`, {
      method: "POST",
      headers: { "content-type": "application/json", "neon-connection-string": dbUrl },
      body: JSON.stringify({ query: "SELECT COUNT(*) AS n FROM bot_wallets", params: [] }),
    });
    if (!r.ok) return undefined;
    const body = await r.json();
    const n = Number(body?.rows?.[0]?.n);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
};
const wallets = await walletCount();

const lines = [
  "🤖 <b>chit bot</b>, the playground, open for anyone",
  "",
  `today's thing: ${tip}.`,
  "",
  "how to try it: tap the button, press start in private, and you are in. buttons all the way, like the bots you know, on a chain that had none.",
  "",
  "<b>beta, on testnet.</b> test eth, test tokens, nothing real. the bot holds the playground key and says so on the card; on mainnet (next, not live) it will never hold yours. things will break and we want to hear about it: any idea, any optimisation, any bug, reply here in the group. we are open to all of it.",
  ...(wallets !== undefined ? ["", `<i>${wallets} playground wallet${wallets === 1 ? "" : "s"} so far</i>`] : []),
];
const text = lines.join("\n");
const reply_markup = {
  inline_keyboard: [
    [{ text: "🎮 try the bot", url: `https://t.me/${bot}?start=go` }],
    [{ text: "what is chit", url: site }],
  ],
};

if (!token || !chat) { console.log("would send:\n" + text + "\n" + JSON.stringify(reply_markup)); process.exit(0); }
const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup }),
});
if (!r.ok) { console.error(`telegram answered ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
console.log("posted the bot invitation");
