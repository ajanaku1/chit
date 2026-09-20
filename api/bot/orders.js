// Plain JS on purpose: see api/fleet/campaign.js. The clock for the bot's
// standing orders (limit buys and DCA on session keys): Vercel's cron calls
// this every five minutes with the CRON_SECRET bearer, one pass fires what
// is due, the answer is { fired, landed, refused }. Nothing is due, nothing
// is sent.
import { handleOrdersRequest } from "../../dist/src/fleet/bot-orders-runtime.js";

export const config = { maxDuration: 300 };

export function GET(request) { return handleOrdersRequest(request); }
export function POST(request) { return handleOrdersRequest(request); }
