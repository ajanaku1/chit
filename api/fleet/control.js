import { handleFleetRequest } from "../../dist/src/fleet/service-runtime.js";

export function POST(request) {
  return handleFleetRequest(request, ["pause", "resume", "revoke", "close"]);
}
