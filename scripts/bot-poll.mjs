/**
 * Runs the bot from one machine by long polling, no webhook and no host:
 * for trying it before the deploy, and for screenshots. The same runtime as
 * api/bot.js (`getBot()` and every refusal in it), fed from getUpdates
 * instead of a POST.
 *
 *   npm run build && node --env-file=.env scripts/bot-poll.mjs
 *
 * Needs what the hosted bot needs (docs/chit-bot.md), with two allowances
 * for one machine: BOT_MEMORY_STORE=1 instead of DATABASE_URL (wallets
 * live in this process and are gone when it stops), and any 16+ character
 * TELEGRAM_WEBHOOK_SECRET (polling pulls from Telegram, nothing arrives
 * unasked). Telegram allows either a webhook or polling, not both: this
 * removes the webhook when it starts, so do not run it against a bot that
 * is live on the host. Stop with ctrl-c.
 */

import { getBot, botFaultForTests } from "../dist/src/fleet/bot-runtime.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("TELEGRAM_BOT_TOKEN is not set"); process.exit(1); }
const bot = getBot();
if (!bot) { console.error(`the bot refused to start: ${botFaultForTests()}`); process.exit(1); }

const api = async (method, payload = {}) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await r.json().catch(() => ({}));
  if (!body.ok) throw new Error(`${method}: ${body.description ?? r.status}`);
  return body.result;
};

const me = await api("getMe");
await api("deleteWebhook", { drop_pending_updates: false });
await api("setMyCommands", { commands: [
  { command: "start", description: "your testnet wallet and the card; everything else is a button" },
  { command: "pool", description: "the pool's numbers, also in the group" },
  { command: "help", description: "how it works" },
] });
console.log(`polling as @${me.username} (${process.env.BOT_MEMORY_STORE === "1" ? "memory store, wallets vanish with this process" : "database store"}); ctrl-c stops it`);

let offset = 0;
let stopping = false;
process.on("SIGINT", () => { stopping = true; console.log("\nstopping"); });
while (!stopping) {
  let updates = [];
  try {
    updates = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
  } catch (error) {
    console.error(`getUpdates: ${error instanceof Error ? error.message : error}`);
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }
  for (const update of updates) {
    offset = update.update_id + 1;
    const who = update.message?.from?.id ?? update.callback_query?.from?.id;
    const what = update.message?.text ?? update.callback_query?.data ?? "?";
    console.log(`${new Date().toISOString()} ${who}: ${what}`);
    await bot.handle(update);
  }
}
