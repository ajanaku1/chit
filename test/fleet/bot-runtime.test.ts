import assert from "node:assert/strict";
import test from "node:test";

import { botFaultForTests, handleBotRequest, resetBotForTests } from "../../src/fleet/bot-runtime.js";

/**
 * The webhook's door: every update must carry the secret Telegram was given,
 * a deployment without the secret serves nobody, and a half-configured
 * deployment refuses with a reason instead of building a bot on guesses.
 */

const ENV = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "BOT_USERNAME", "BOT_KEY_SECRET", "BOT_FAUCET_PRIVATE_KEY", "BOT_FAUCET_ETH", "BOT_FAUCET_DAILY_ETH", "DATABASE_URL", "BOT_MEMORY_STORE", "FLEET_CHAIN_ID", "BOT_FLEET_OFF"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
type Env = Partial<Record<(typeof ENV)[number], string | undefined>>;
const setEnv = (values: Env): void => {
  for (const k of ENV) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  resetBotForTests();
};
const post = (body: unknown, header?: string): Request =>
  new Request("https://chit.tools/api/bot", { method: "POST", headers: { "content-type": "application/json", ...(header ? { "x-telegram-bot-api-secret-token": header } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
const chatter = { message: { message_id: 1, text: "gm", chat: { id: -100, type: "supergroup" }, from: { id: 1 } } };
const STRONG = "a-secret-long-enough-to-seal-keys-with-1234";
const FULL = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_WEBHOOK_SECRET: "sixteen-characters-at-least", BOT_USERNAME: "chit_playground_bot", BOT_KEY_SECRET: STRONG, BOT_MEMORY_STORE: "1", BOT_FLEET_OFF: "1" } as const;

test.after(() => { setEnv(saved as never); });

test("without TELEGRAM_WEBHOOK_SECRET nothing is served, header or not", async () => {
  setEnv({ ...FULL, TELEGRAM_WEBHOOK_SECRET: undefined });
  assert.equal((await handleBotRequest(post(chatter))).status, 403);
  assert.equal((await handleBotRequest(post(chatter, "anything"))).status, 403);
});

test("a wrong or missing secret header is 403; the right one reaches the bot", async () => {
  setEnv(FULL);
  assert.equal((await handleBotRequest(post(chatter))).status, 403);
  assert.equal((await handleBotRequest(post(chatter, "sixteen-characters-at-leasT"))).status, 403);
  assert.equal((await handleBotRequest(post(chatter, "sixteen-characters-at-least-and-more"))).status, 403);
  const r = await handleBotRequest(post(chatter, FULL.TELEGRAM_WEBHOOK_SECRET));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const bad = await handleBotRequest(post("{not json", FULL.TELEGRAM_WEBHOOK_SECRET));
  assert.deepEqual(await bad.json(), { ok: false });
});

test("a half-configured deployment refuses with a reason and answers 200 so Telegram stops retrying", async () => {
  const refused = async (env: Env, why: RegExp): Promise<void> => {
    setEnv({ ...FULL, ...env });
    const r = await handleBotRequest(post(chatter, process.env.TELEGRAM_WEBHOOK_SECRET));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: false, why: "bot_not_configured" });
    assert.match(botFaultForTests() ?? "", why);
  };
  await refused({ TELEGRAM_BOT_TOKEN: undefined }, /TELEGRAM_BOT_TOKEN/);
  await refused({ TELEGRAM_WEBHOOK_SECRET: "short" }, /TELEGRAM_WEBHOOK_SECRET must be 16\+/);
  await refused({ BOT_KEY_SECRET: "a".repeat(40) }, /twelve distinct/);
  await refused({ BOT_KEY_SECRET: "short-but-varied-1234567890" }, /32\+ characters/);
  await refused({ BOT_USERNAME: undefined }, /BOT_USERNAME/);
  await refused({ BOT_MEMORY_STORE: undefined }, /DATABASE_URL is not set/);
  await refused({ BOT_FAUCET_ETH: "abc" }, /BOT_FAUCET_ETH is not an amount/);
  await refused({ BOT_FAUCET_DAILY_ETH: "0.5x" }, /BOT_FAUCET_DAILY_ETH is not an amount/);
  await refused({ BOT_FAUCET_PRIVATE_KEY: "0x1234" }, /BOT_FAUCET_PRIVATE_KEY/);
  await refused({ FLEET_CHAIN_ID: "4663" }, /testnet only/);
});
