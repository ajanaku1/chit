// Plain JS on purpose: see api/fleet/campaign.js. Called by the Vercel cron and
// opportunistically by the app; it can only do what the chain already permits.
import { handleFleetRequest } from "../../dist/src/fleet/service-runtime.js";

export function POST(request) {
  return handleFleetRequest(request, ["sweep"]);
}

export function GET(request) {
  return handleFleetRequest(new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "sweep", body: {} }),
  }), ["sweep"]);
}
