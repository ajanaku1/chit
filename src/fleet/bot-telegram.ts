/**
 * The Bot API, as much of it as the bot uses: send, edit, answer a button.
 *
 * A port so the handlers can be tested against a recorder; the real one is
 * three fetches. Messages are HTML; every user-supplied string goes through
 * `esc` before it is placed in one.
 */

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type Keyboard = InlineButton[][];

export type Outgoing =
  | { kind: "send"; chatId: string; text: string; keyboard?: Keyboard }
  | { kind: "edit"; chatId: string; messageId: number; text: string; keyboard?: Keyboard }
  | { kind: "answer"; callbackId: string; text?: string };

export interface Telegram {
  deliver(out: Outgoing): Promise<void>;
}

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const createTelegram = (token: string): Telegram => {
  const call = async (method: string, payload: Record<string, unknown>): Promise<void> => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    // An edit that changes nothing is Telegram's "message is not modified", which is fine.
    if (!body.ok && !/not modified/.test(body.description ?? "")) console.error(`telegram ${method}: ${body.description ?? r.status}`);
  };
  return {
    async deliver(out) {
      if (out.kind === "send") {
        await call("sendMessage", { chat_id: out.chatId, text: out.text, parse_mode: "HTML", disable_web_page_preview: true, ...(out.keyboard ? { reply_markup: { inline_keyboard: out.keyboard } } : {}) });
      } else if (out.kind === "edit") {
        await call("editMessageText", { chat_id: out.chatId, message_id: out.messageId, text: out.text, parse_mode: "HTML", disable_web_page_preview: true, ...(out.keyboard ? { reply_markup: { inline_keyboard: out.keyboard } } : {}) });
      } else {
        await call("answerCallbackQuery", { callback_query_id: out.callbackId, ...(out.text ? { text: out.text } : {}) });
      }
    },
  };
};

/** A recorder for tests: every outgoing message, in order. */
export class RecordingTelegram implements Telegram {
  readonly sent: Outgoing[] = [];
  async deliver(out: Outgoing): Promise<void> {
    this.sent.push(out);
  }
  texts(): string[] {
    return this.sent.filter((o): o is Extract<Outgoing, { kind: "send" | "edit" }> => o.kind !== "answer").map((o) => o.text);
  }
  last(): string {
    return this.texts().at(-1) ?? "";
  }
}
