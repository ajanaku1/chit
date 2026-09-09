// Plain JS on purpose: Vercel's own TypeScript pass type-checks viem
// differently from our tsc, so the fleet runtime is compiled by `npm run
// build` first and imported here as JavaScript.
import { handleFleetRequest } from "../../dist/src/fleet/service-runtime.js";

export function POST(request) {
  return handleFleetRequest(request, ["quote", "challenge", "create", "confirmRecovery", "fund", "activate", "read", "topUp"]);
}
