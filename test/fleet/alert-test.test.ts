import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAlertTest } from "../../src/fleet/alert-test.js";

/**
 * The service's alerts are silent until something goes wrong, and the daily
 * digest is silent when nothing was held, so a host whose chat id or bot token
 * is wrong says nothing right up until the day it matters. This route sends one
 * line on demand, through the same sink a real alert uses, and answers with
 * what Telegram said, so delivery is proved rather than assumed.
 *
 * It sends only with the host's CRON_SECRET, and unlike the sweep it never
 * runs open when the secret is unset: a route anyone can call to post in the
 * operator chat is a way to bury a real alert under noise.
 */

const SECRET = "s".repeat(64);
const env = (over: Record<string, string | undefined> = {}) => ({
  CRON_SECRET: SECRET, TELEGRAM_BOT_TOKEN: "123:abc", MONITOR_CHAT_ID: "-1004300939625", FLEET_CHAIN_ID: "4663", ...over,
});

const recorder = (status = 200) => {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string, init?: { body?: string }) => {
    sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { sent, fetcher };
};

const call = (authorization?: string): Request =>
  new Request("https://app.chit.tools/api/fleet/alert-test", { method: "POST", headers: authorization ? { authorization } : {} });

describe("the alert test route", () => {
  it("refuses and sends nothing when the host has no CRON_SECRET", async () => {
    const { sent, fetcher } = recorder();
    const response = await handleAlertTest(call("Bearer anything"), env({ CRON_SECRET: undefined }), fetcher);
    assert.equal(response.status, 401);
    assert.equal(sent.length, 0);
  });

  it("refuses and sends nothing without the right bearer", async () => {
    const { sent, fetcher } = recorder();
    for (const auth of [undefined, "Bearer wrong", SECRET]) {
      const response = await handleAlertTest(call(auth), env(), fetcher);
      assert.equal(response.status, 401);
    }
    assert.equal(sent.length, 0);
  });

  it("sends one line to the monitor chat, naming the chain, and says Telegram took it", async () => {
    const { sent, fetcher } = recorder(200);
    const response = await handleAlertTest(call(`Bearer ${SECRET}`), env(), fetcher);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sent: true, telegramStatus: 200, chainId: "4663" });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.url, /\/bot123:abc\/sendMessage$/);
    assert.equal(sent[0]!.body["chat_id"], "-1004300939625");
    assert.match(String(sent[0]!.body["text"]), /chain 4663/);
    assert.match(String(sent[0]!.body["text"]), /alert-test/);
  });

  it("says so when Telegram refuses, instead of reporting a send that did not land", async () => {
    const { fetcher } = recorder(400);
    const response = await handleAlertTest(call(`Bearer ${SECRET}`), env(), fetcher);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { sent: false, telegramStatus: 400, chainId: "4663" });
  });

  it("says the host is not configured when the token or the chat is missing, and sends nothing", async () => {
    for (const missing of ["TELEGRAM_BOT_TOKEN", "MONITOR_CHAT_ID"]) {
      const { sent, fetcher } = recorder();
      const response = await handleAlertTest(call(`Bearer ${SECRET}`), env({ [missing]: undefined }), fetcher);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { sent: false, reason: "not_configured", chainId: "4663" });
      assert.equal(sent.length, 0);
    }
  });
});
