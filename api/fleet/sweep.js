// Plain JS on purpose: see api/fleet/campaign.js. Called on a schedule (the
// GitHub Actions cron every four hours, and Vercel's two daily crons) and
// opportunistically by the app; it can only do what the chain already permits.
// The scheduled sweep is where charges are queued in a batch, so with
// CRON_SECRET set only a caller carrying it may start one. This is the
// queueing clock; the posting clock is api/fleet/sweep-posting.js.
import { handleFleetRequest } from "../../dist/src/fleet/service-runtime.js";
import { sweepTriggerAllowed } from "../../dist/src/fleet/sweep-trigger.js";

// The same gate on both verbs: a POST with {"action":"sweep"} is the
// scheduled sweep too, and an open one would let anyone queue the batch in
// the window right after a trader's buy, which is the correlation the
// schedule exists to prevent.
export function POST(request) {
  if (!sweepTriggerAllowed(request, process.env.CRON_SECRET)) {
    return Response.json({ code: "unauthorized", retryable: false, reason: "cron_secret" }, { status: 401 });
  }
  return handleFleetRequest(request, ["sweep"]);
}

export function GET(request) {
  if (!sweepTriggerAllowed(request, process.env.CRON_SECRET)) {
    return Response.json({ code: "unauthorized", retryable: false, reason: "cron_secret" }, { status: 401 });
  }
  return handleFleetRequest(new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "sweep", body: {} }),
  }), ["sweep"]);
}
