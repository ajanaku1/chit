// Plain JS on purpose: see api/fleet/campaign.js.
import { handleSponsorRequest } from "../../dist/src/fleet/sponsor-runtime.js";

export function POST(request) {
  return handleSponsorRequest(request, ["info", "challenge", "sponsor", "submit", "register", "policy", "pause", "resume", "close", "status", "list"]);
}
