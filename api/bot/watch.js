// Plain JS on purpose: see api/fleet/campaign.js. The clock for the chain
// watcher: Vercel's cron calls this every five minutes with the CRON_SECRET
// bearer, one pass reads the venue's swap logs since the last, posts the big
// buys to the group and to the users who asked, and hands each buy to the
// handlers other features registered; the answer is { from, to, buys,
// delivered }. Nothing new on the chain, nothing is sent.
import { handleWatchRequest } from "../../dist/src/fleet/bot-watch-runtime.js";

export const config = { maxDuration: 300 };

export function GET(request) { return handleWatchRequest(request); }
export function POST(request) { return handleWatchRequest(request); }
