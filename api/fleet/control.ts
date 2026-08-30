import { handleFleetRequest } from "../../src/fleet/service-runtime.js";

export function POST(request: Request): Promise<Response> {
  return handleFleetRequest(request, ["pause", "resume", "revoke", "close"]);
}
