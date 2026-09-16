/**
 * The Bot API, as much of it as the bot uses: send, edit, answer a button,
 * and a card with a banner on top (a photo with a caption), which can be
 * swapped for another banner card in place.
 *
 * A port so the handlers can be tested against a recorder; the real one is
 * a handful of fetches. Messages are HTML; every user-supplied string goes
 * through `esc` before it is placed in one. A banner is an https URL
 * (Telegram fetches it) or a local file path (uploaded as multipart), so the
 * same cards work from the host and from one machine.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type Keyboard = InlineButton[][];

export type Outgoing =
  | { kind: "send"; chatId: string; text: string; keyboard?: Keyboard; /** Opens the reply field with a hint: how a custom amount or an address is asked for. */ ask?: string }
  | { kind: "edit"; chatId: string; messageId: number; text: string; keyboard?: Keyboard }
  /** A banner card: the photo on top, the text as its caption (at most 1024 characters), the buttons under it. */
  | { kind: "photo"; chatId: string; photo: string; text: string; keyboard?: Keyboard }
  /** The same, in place of an earlier banner card: the photo and the caption change together. */
  | { kind: "editPhoto"; chatId: string; messageId: number; photo: string; text: string; keyboard?: Keyboard }
  | { kind: "answer"; callbackId: string; text?: string };

export interface Telegram {
  deliver(out: Outgoing): Promise<void>;
}

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram's limits on what a keyboard, a reply field and a caption may carry; the real API refuses the whole message past them. */
export const CALLBACK_DATA_MAX_BYTES = 64;
export const PLACEHOLDER_MAX_CHARS = 64;
export const CAPTION_MAX_CHARS = 1024;

const isUrl = (photo: string): boolean => /^https?:\/\//.test(photo);

export const createTelegram = (token: string): Telegram => {
  const done = async (method: string, r: Response): Promise<void> => {
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    // An edit that changes nothing is Telegram's "message is not modified", which is fine.
    if (!body.ok && !/not modified/.test(body.description ?? "")) console.error(`telegram ${method}: ${body.description ?? r.status}`);
  };
  const call = async (method: string, payload: Record<string, unknown>): Promise<void> => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    await done(method, r);
  };
  /** The same call with a file from disk: every field as a form part, the file under `fileField`. */
  const upload = async (method: string, fields: Record<string, unknown>, fileField: string, filePath: string): Promise<void> => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const bytes = await readFile(filePath);
    form.set(fileField, new Blob([bytes], { type: "image/png" }), path.basename(filePath));
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form });
    await done(method, r);
  };
  const markup = (keyboard?: Keyboard) => (keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});
  return {
    async deliver(out) {
      if (out.kind === "send") {
        const replyMarkup = out.ask ? { force_reply: true, input_field_placeholder: out.ask, selective: true } : out.keyboard ? { inline_keyboard: out.keyboard } : undefined;
        await call("sendMessage", { chat_id: out.chatId, text: out.text, parse_mode: "HTML", disable_web_page_preview: true, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) });
      } else if (out.kind === "edit") {
        await call("editMessageText", { chat_id: out.chatId, message_id: out.messageId, text: out.text, parse_mode: "HTML", disable_web_page_preview: true, ...markup(out.keyboard) });
      } else if (out.kind === "photo") {
        const fields = { chat_id: out.chatId, caption: out.text, parse_mode: "HTML", ...markup(out.keyboard) };
        if (isUrl(out.photo)) await call("sendPhoto", { ...fields, photo: out.photo });
        else await upload("sendPhoto", fields, "photo", out.photo);
      } else if (out.kind === "editPhoto") {
        const media = { type: "photo", caption: out.text, parse_mode: "HTML" };
        const fields = { chat_id: out.chatId, message_id: out.messageId, ...markup(out.keyboard) };
        if (isUrl(out.photo)) await call("editMessageMedia", { ...fields, media: { ...media, media: out.photo } });
        else await upload("editMessageMedia", { ...fields, media: { ...media, media: "attach://banner" } }, "banner", out.photo);
      } else {
        await call("answerCallbackQuery", { callback_query_id: out.callbackId, ...(out.text ? { text: out.text } : {}) });
      }
    },
  };
};

/** A recorder for tests: every outgoing message, in order, refusing what Telegram would refuse. */
export class RecordingTelegram implements Telegram {
  readonly sent: Outgoing[] = [];
  async deliver(out: Outgoing): Promise<void> {
    if (out.kind !== "answer" && out.keyboard) {
      for (const b of out.keyboard.flat()) {
        if ("callback_data" in b && Buffer.byteLength(b.callback_data, "utf8") > CALLBACK_DATA_MAX_BYTES) throw new Error(`callback_data over ${CALLBACK_DATA_MAX_BYTES} bytes: ${b.callback_data}`);
      }
    }
    if (out.kind === "send" && out.ask && out.ask.length > PLACEHOLDER_MAX_CHARS) throw new Error(`placeholder over ${PLACEHOLDER_MAX_CHARS} characters: ${out.ask}`);
    if ((out.kind === "photo" || out.kind === "editPhoto") && out.text.length > CAPTION_MAX_CHARS) throw new Error(`caption over ${CAPTION_MAX_CHARS} characters`);
    this.sent.push(out);
  }
  texts(): string[] {
    return this.sent.filter((o): o is Exclude<Outgoing, { kind: "answer" }> => o.kind !== "answer").map((o) => o.text);
  }
  last(): string {
    return this.texts().at(-1) ?? "";
  }
}
