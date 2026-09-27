// Plain JS on purpose: see api/fleet/campaign.js. The sales clock: Vercel's
// cron calls this every five minutes, and it advances every sale with work
// left (src/fleet/service-runtime.ts, handleSalesSweep; docs/design-sell.md).
import { handleSalesSweep } from "../../dist/src/fleet/service-runtime.js";

export function GET(request) {
  return handleSalesSweep(request);
}

export function POST(request) {
  return handleSalesSweep(request);
}
