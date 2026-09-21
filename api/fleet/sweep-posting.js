// Plain JS on purpose: see api/fleet/campaign.js. The posting clock: Vercel's
// crons call this every two hours. It posts every charge that is due and funds
// every draw whose wait is over, and it never queues what is owed. Queueing is
// a privacy parameter (how often it happens is the size of the batch a charge
// hides in) and stays on the scheduled sweep's own clock, api/fleet/sweep.js.
// This one only has to beat the pool's POST_WINDOW, so it may tick often.
// test/fleet/sweep-timing.test.ts holds both clocks.
import { handleFleetRequest } from "../../dist/src/fleet/service-runtime.js";
import { sweepTriggerAllowed } from "../../dist/src/fleet/sweep-trigger.js";

// The body is written here on both verbs, never taken from the caller: nothing
// sent to this route can make it queue.
const postingOnly = (request) =>
  handleFleetRequest(new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "sweep", body: { queueOwed: false } }),
  }), ["sweep"]);

export function POST(request) {
  if (!sweepTriggerAllowed(request, process.env.CRON_SECRET)) {
    return Response.json({ code: "unauthorized", retryable: false, reason: "cron_secret" }, { status: 401 });
  }
  return postingOnly(request);
}

export function GET(request) {
  if (!sweepTriggerAllowed(request, process.env.CRON_SECRET)) {
    return Response.json({ code: "unauthorized", retryable: false, reason: "cron_secret" }, { status: 401 });
  }
  return postingOnly(request);
}
