/**
 * One bot, two floors: a user lands on mainnet, /playground or the button
 * moves them and draws that floor's home card, every later update goes to
 * the floor they are on, and the floor is remembered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DualBot, MemoryFloorStore, SWITCH_TO_MAINNET, SWITCH_TO_PLAYGROUND } from "../../src/fleet/bot-dual.js";
import type { Update } from "../../src/fleet/bot-handlers.js";
import { RecordingTelegram } from "../../src/fleet/bot-telegram.js";

const dm = (text: string, from = 7): Update => ({ message: { message_id: 1, text, chat: { id: from, type: "private" }, from: { id: from } } });
const tap = (data: string, from = 7): Update => ({ callback_query: { id: "cb", data, from: { id: from }, message: { message_id: 9, chat: { id: from, type: "private" } } } });

const floorSpy = (name: string) => {
  const seen: string[] = [];
  return { seen, handler: { async handle(u: Update) { seen.push(u.message?.text ?? u.callback_query?.data ?? "?"); } }, name };
};

test("mainnet is the ground floor; the playground is a room; each user is remembered on their floor", async () => {
  const mainnet = floorSpy("mainnet"), playground = floorSpy("playground");
  const floors = new MemoryFloorStore();
  const telegram = new RecordingTelegram();
  const bot = new DualBot({ mainnet: mainnet.handler, playground: playground.handler, floors, telegram });
  await bot.handle(dm("/start"));
  await bot.handle(dm("0x00000000000000000000000000000000000000ce"));
  assert.deepEqual(mainnet.seen, ["/start", "0x00000000000000000000000000000000000000ce"]);
  assert.deepEqual(playground.seen, []);
  // The door: the switch draws the playground's own home card (its /start), and the floor sticks.
  await bot.handle(tap(SWITCH_TO_PLAYGROUND));
  assert.equal(telegram.sent.at(-1)!.kind, "answer");
  assert.deepEqual(playground.seen, ["/start"]);
  assert.equal(await floors.floorOf("7"), "playground");
  await bot.handle(tap("buy:"));
  assert.deepEqual(playground.seen, ["/start", "buy:"]);
  assert.equal(mainnet.seen.length, 2, "nothing more reached mainnet");
  // /mainnet takes them back; another user is untouched.
  await bot.handle(dm("/mainnet"));
  assert.equal(await floors.floorOf("7"), "mainnet");
  assert.deepEqual(mainnet.seen.at(-1), "/start");
  await bot.handle(dm("/start", 8));
  assert.equal(await floors.floorOf("8"), undefined, "never chose: on the ground floor by default");
  assert.deepEqual(mainnet.seen.at(-1), "/start");
  await bot.handle(tap(SWITCH_TO_MAINNET, 8));
  assert.equal(await floors.floorOf("8"), "mainnet");
});
