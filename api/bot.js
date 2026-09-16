// Plain JS on purpose: see api/fleet/campaign.js. Telegram posts every update here.
import { getBot, handleBotRequest } from "../dist/src/fleet/bot-runtime.js";

export function POST(request) {
  return handleBotRequest(request);
}

/** Live or not, for the daily invitation to check before it posts a button: 200 once the runtime built, 503 while a variable is missing. The reason stays in the log. */
export function GET() {
  return getBot()
    ? new Response("chit bot: live, telegram posts here", { status: 200 })
    : new Response("chit bot: not configured", { status: 503 });
}
