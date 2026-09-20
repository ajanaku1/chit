/**
 * One bot, two floors. @usechit_bot stays the bot people already have; it
 * only receives updates. Mainnet (the session mode: your keys stay with
 * you) is the ground floor, the testnet playground (a throwaway key, test
 * ETH) is a room off it. Each Telegram user is on one floor at a time,
 * remembered in the store; `/mainnet` and `/playground` (or the button on
 * either home card) move them. Every update is routed to the floor the user
 * is on, so the two handlers never see each other's buttons.
 *
 * Both floors share the one webhook and the one bot token. Nothing about
 * the bot's identity changes when the mainnet floor arrives.
 */

import type { Update } from "./bot-handlers.js";
import type { Telegram } from "./bot-telegram.js";

export type Floor = "mainnet" | "playground";

export interface FloorStore {
  floorOf(tgId: string): Promise<Floor | undefined>;
  setFloor(tgId: string, floor: Floor): Promise<void>;
}

export type FloorHandler = { handle(update: Update): Promise<void> };

export type DualBotDeps = {
  mainnet: FloorHandler;
  playground: FloorHandler;
  floors: FloorStore;
  telegram: Telegram;
  /** Where a user lands who has never chosen: the ground floor. */
  defaultFloor?: Floor;
};

export const SWITCH_TO_MAINNET = "floor:mainnet";
export const SWITCH_TO_PLAYGROUND = "floor:playground";

const userOf = (u: Update): { tgId: string; chatId: string } | undefined => {
  if (u.message?.from) return { tgId: String(u.message.from.id), chatId: String(u.message.chat.id) };
  if (u.callback_query?.message) return { tgId: String(u.callback_query.from.id), chatId: String(u.callback_query.message.chat.id) };
  return undefined;
};

export class DualBot {
  readonly #d: DualBotDeps;
  constructor(d: DualBotDeps) { this.#d = d; }

  async handle(u: Update): Promise<void> {
    const who = userOf(u);
    if (!who) return;
    const cmd = u.message?.text?.trim().split(/\s+/)[0];
    const data = u.callback_query?.data;
    const wanted: Floor | undefined = cmd === "/mainnet" || data === SWITCH_TO_MAINNET ? "mainnet" : cmd === "/playground" || data === SWITCH_TO_PLAYGROUND ? "playground" : undefined;
    if (wanted) {
      await this.#d.floors.setFloor(who.tgId, wanted);
      if (u.callback_query) await this.#d.telegram.deliver({ kind: "answer", callbackId: u.callback_query.id, text: wanted === "mainnet" ? "mainnet: your keys stay with you" : "testnet playground: test eth, nothing real" });
      // The floor's own /start draws its home card; a switch is a fresh card, never an edit of the other floor's.
      return this.#floor(wanted).handle({ message: { message_id: 0, text: "/start", chat: { id: Number(who.chatId), type: u.message?.chat.type ?? "private" }, from: { id: Number(who.tgId) } } });
    }
    const floor = (await this.#d.floors.floorOf(who.tgId)) ?? this.#d.defaultFloor ?? "mainnet";
    return this.#floor(floor).handle(u);
  }

  #floor(f: Floor): FloorHandler { return f === "mainnet" ? this.#d.mainnet : this.#d.playground; }
}

export class MemoryFloorStore implements FloorStore {
  readonly floors = new Map<string, Floor>();
  async floorOf(tgId: string) { return this.floors.get(tgId); }
  async setFloor(tgId: string, floor: Floor) { this.floors.set(tgId, floor); }
}

type Row = Record<string, unknown>;
export type FloorSql = { query(sql: string, params?: unknown[]): Promise<readonly Row[]> };

export class NeonFloorStore implements FloorStore {
  #ready: Promise<void> | undefined;
  constructor(private readonly sql: FloorSql) {}
  #init(): Promise<void> {
    return (this.#ready ??= this.sql.query(`CREATE TABLE IF NOT EXISTS bot_floors (tg_id TEXT PRIMARY KEY, floor TEXT NOT NULL, chosen_at TIMESTAMPTZ NOT NULL)`).then(() => undefined).catch((e) => { this.#ready = undefined; throw e; }));
  }
  async floorOf(tgId: string) {
    await this.#init();
    const [r] = await this.sql.query(`SELECT floor FROM bot_floors WHERE tg_id = $1`, [tgId]);
    return r && (r.floor === "mainnet" || r.floor === "playground") ? r.floor : undefined;
  }
  async setFloor(tgId: string, floor: Floor) {
    await this.#init();
    await this.sql.query(`INSERT INTO bot_floors (tg_id, floor, chosen_at) VALUES ($1, $2, NOW()) ON CONFLICT (tg_id) DO UPDATE SET floor = EXCLUDED.floor, chosen_at = NOW()`, [tgId, floor]);
  }
}
