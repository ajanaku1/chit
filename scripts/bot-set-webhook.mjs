/**
 * Points Telegram at the bot's webhook, once, and registers the command menu.
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... SITE=https://chit.tools node scripts/bot-set-webhook.mjs
 *   node scripts/bot-set-webhook.mjs delete      # unhooks
 *
 * Plain node, no install. The secret is sent by Telegram on every update as
 * X-Telegram-Bot-Api-Secret-Token and checked by api/bot.js.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const site = (process.env.SITE ?? "https://chit.tools").replace(/\/+$/, "");
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const call = async (method, payload) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = await r.json();
  if (!body.ok) throw new Error(`${method}: ${body.description}`);
  return body.result;
};

if (process.argv[2] === "delete") {
  await call("deleteWebhook", { drop_pending_updates: true });
  console.log("webhook removed");
} else {
  if (!secret || secret.length < 16) throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16+ characters");
  await call("setWebhook", { url: `${site}/api/bot`, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  await call("setMyCommands", {
    commands: [
      { command: "start", description: "your testnet wallet, topped up" },
      { command: "buy", description: "buy through Uniswap v4: /buy 0.002" },
      { command: "sell", description: "sell a share: /sell 50" },
      { command: "positions", description: "what you hold" },
      { command: "withdraw", description: "move test ETH out: /withdraw 0x… 0.01" },
      { command: "faucet", description: "test ETH, once a day" },
      { command: "fleet", description: "what the real product does" },
      { command: "pool", description: "the pool's numbers" },
      { command: "help", description: "the list" },
    ],
  });
  const info = await call("getWebhookInfo", {});
  console.log(`webhook set: ${info.url}; pending ${info.pending_update_count}`);
}
