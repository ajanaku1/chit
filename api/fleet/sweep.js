// Plain JS on purpose: see api/fleet/campaign.js. Called on a schedule (the
// GitHub Actions cron every four hours, and Vercel's own crons) and
// opportunistically by the app; it can only do what the chain already permits.
// The scheduled sweep is where charges are queued in a batch, so with
// CRON_SECRET set only a caller carrying it may start one.
import { handleFleetRequest } from "../../dist/src/fleet/service-runtime.js";
import { sweepTriggerAllowed } from "../../dist/src/fleet/sweep-trigger.js";

export function POST(request) {
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
