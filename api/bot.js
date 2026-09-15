// Plain JS on purpose: see api/fleet/campaign.js. Telegram posts every update here.
import { handleBotRequest } from "../dist/src/fleet/bot-runtime.js";

export function POST(request) {
  return handleBotRequest(request);
}

export function GET() {
  return new Response("chit bot: telegram posts here", { status: 200 });
}
