import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { alertLine, createAlertSink, type Alert } from "../../src/fleet/alerts.js";
import { createMemoryStore, type StorePort } from "../../src/fleet/store.js";

/**
 * The alert sink (T048): the one way the service says something went wrong
 * with money, to the operator chat, on FR-023's three timescales.
 *
 * What it must never do is fail the thing it is reporting on: a withdrawal
 * that was refused is already bad news, and an alert that throws on top of it
 * would turn a refusal into a 503 and lose the reason. So every failure here
 * is logged and swallowed.
 */

const TOKEN = "123:abc";
const CHAT = "-1002";
const env = (over: Record<string, string> = {}) => ({ TELEGRAM_BOT_TOKEN: TOKEN, MONITOR_CHAT_ID: CHAT, FLEET_CHAIN_ID: "4663", ...over });

type Sent = { url: string; body: Record<string, unknown> };

const recorder = (answer: () => Partial<Response> | Promise<never> = () => ({ ok: true, status: 200 })) => {
  const sent: Sent[] = [];
  const fetcher = (async (url: string, init?: { body?: string }) => {
    sent.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return answer() as Response;
  }) as unknown as typeof fetch;
  return { sent, fetcher };
};

const said: string[] = [];
const log = (line: string): void => { said.push(line); };

const sink = (over: { env?: Record<string, string>; store?: StorePort; fetcher?: typeof fetch; now?: () => Date } = {}) => {
  const { sent, fetcher } = recorder();
  return {
    sent,
    sink: createAlertSink({
      env: over.env ?? env(),
      fetch: over.fetcher ?? fetcher,
      store: over.store ?? createMemoryStore(),
      now: over.now ?? (() => new Date("2026-09-22T09:00:00Z")),
      log,
    }),
  };
};

const refused: Alert = { what: "withdrawal-refused", summary: "a withdrawal was refused: operator_float_short", acts: "money-path", timescale: "immediately" };

describe("the alert sink", () => {
  it("sends an immediate alert to the operator's chat, and says who acts", async () => {
    const { sink: alerts, sent } = sink();
    await alerts.raise(refused);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.url, new RegExp(`^https://api\\.telegram\\.org/bot${TOKEN}/sendMessage$`));
    assert.equal(sent[0]!.body["chat_id"], CHAT);
    const text = String(sent[0]!.body["text"]);
    assert.match(text, /^Chit fleet service · alert · chain 4663\n/);
    assert.match(text, /NOW withdrawal-refused \(money-path\): a withdrawal was refused: operator_float_short/);
  });

  it("never sends to the group: the operator chat or nowhere", async () => {
    const { sink: alerts, sent } = sink({ env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100group" } });
    await alerts.raise(refused);
    assert.deepEqual(sent, [], "with no MONITOR_CHAT_ID the alert is logged, not sent to the group");
    assert.ok(said.some((line) => /MONITOR_CHAT_ID/.test(line)), said.join("\n"));
  });

  it("an alert that cannot be classified takes the faster class (FR-023)", () => {
    assert.match(alertLine({ what: "odd", summary: "something", acts: "both" }), /^NOW /, "no timescale is the immediate one");
    assert.match(alertLine({ ...refused, timescale: "four-hours" }), /^4H /);
    assert.match(alertLine({ ...refused, timescale: "daily" }), /^DAY /);
  });

  it("holds a daily alert for the digest instead of sending it", async () => {
    const store = createMemoryStore();
    const { sink: alerts, sent } = sink({ store });
    await alerts.raise({ what: "postings-failed", summary: "2 postings failed", acts: "money-path", timescale: "daily" });
    assert.deepEqual(sent, [], "nothing goes out at once");
    const held = await store.alerts.takeHeld();
    assert.equal(held.length, 1);
    assert.match(held[0]!, /^DAY postings-failed \(money-path\): 2 postings failed/);
  });

  it("the digest goes out once a day, whichever instance sweeps first", async () => {
    const store = createMemoryStore();
    const morning = () => new Date("2026-09-22T07:30:00Z");
    const a = sink({ store, now: morning });
    const b = sink({ store, now: morning });
    await a.sink.raise({ what: "postings-failed", summary: "2 postings failed", acts: "money-path", timescale: "daily" });

    await a.sink.flushDaily();
    await b.sink.flushDaily();
    assert.equal(a.sent.length, 1, "the first instance past the digest hour sends it");
    assert.deepEqual(b.sent, [], "the second finds the day already claimed");
    assert.match(String(a.sent[0]!.body["text"]), /daily digest[\s\S]*postings-failed/);
  });

  it("before the digest hour nothing is flushed, and a day with nothing held is silent", async () => {
    const store = createMemoryStore();
    const early = sink({ store, now: () => new Date("2026-09-22T06:59:00Z") });
    await early.sink.raise({ what: "postings-failed", summary: "1 posting failed", acts: "money-path", timescale: "daily" });
    await early.sink.flushDaily();
    assert.deepEqual(early.sent, [], "the digest hour has not come");
    assert.equal((await store.alerts.takeHeld()).length, 1, "and the line is still held");

    const quiet = sink({ store, now: () => new Date("2026-09-23T08:00:00Z") });
    await quiet.sink.flushDaily();
    assert.deepEqual(quiet.sent, [], "a day with nothing held says nothing: the monitor's digest is the heartbeat");
  });

  it("a telegram that refuses, or a network that fails, is logged and never thrown at the caller", async () => {
    const refusing = (async () => ({ ok: false, status: 429 }) as Response) as unknown as typeof fetch;
    const { sink: a } = sink({ fetcher: refusing });
    await a.raise(refused);
    assert.ok(said.some((line) => /429/.test(line)), said.join("\n"));

    const failing = (async () => { throw new Error("getaddrinfo ENOTFOUND api.telegram.org"); }) as unknown as typeof fetch;
    const { sink: b } = sink({ fetcher: failing });
    await b.raise(refused);
    assert.ok(said.some((line) => /ENOTFOUND/.test(line)), said.join("\n"));
  });

  it("a store that is unreachable does not lose the alert: it goes out at once instead of being held", async () => {
    const broken = { ...createMemoryStore(), alerts: { hold: async () => { throw new Error("no database"); }, takeHeld: async () => [] } };
    const { sink: alerts, sent } = sink({ store: broken });
    await alerts.raise({ what: "postings-failed", summary: "2 postings failed", acts: "money-path", timescale: "daily" });
    assert.equal(sent.length, 1, "held nowhere is sent now: the faster class again");
  });
});
