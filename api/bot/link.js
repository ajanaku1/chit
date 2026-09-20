// Plain JS on purpose: see api/fleet/campaign.js. The Sessions page posts the
// owner's signed link here; session mode only.
import { handleLinkRequest } from "../../dist/src/fleet/bot-link-runtime.js";

export function POST(request) { return handleLinkRequest(request); }
export function GET(request) { return handleLinkRequest(request); }
export function OPTIONS(request) { return handleLinkRequest(request); }
