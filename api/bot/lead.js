// Plain JS on purpose: see api/fleet/campaign.js. The Sessions page posts a
// wallet leader's signed claim here (the wallet they trade from, outside the
// bot); session mode only.
import { handleLeadRequest } from "../../dist/src/fleet/bot-lead-runtime.js";

export function POST(request) { return handleLeadRequest(request); }
export function GET(request) { return handleLeadRequest(request); }
export function OPTIONS(request) { return handleLeadRequest(request); }
