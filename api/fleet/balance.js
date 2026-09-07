// Plain JS on purpose: see api/fleet/campaign.js.
import { handleFleetRequest } from "../../dist/src/fleet/service-runtime.js";

export function POST(request) {
  return handleFleetRequest(request, ["challenge", "balance", "withdraw"]);
}
