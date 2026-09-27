// Plain JS on purpose: see api/fleet/campaign.js. One line to the operator
// chat on demand, to prove a host's alerts arrive (src/fleet/alert-test.ts).
// POST only, with `Authorization: Bearer $CRON_SECRET`; no cron calls it.
import { handleAlertTest } from "../../dist/src/fleet/alert-test.js";

export function POST(request) {
  return handleAlertTest(request, process.env);
}
