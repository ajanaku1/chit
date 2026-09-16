// Plain JS on purpose: see api/fleet/campaign.js. A cron lands here and runs
// scripts/buyback-keeper.mjs, the same file the GitHub Actions schedule runs,
// so there is one keeper and several clocks: GitHub hourly (it skips slots on
// a quiet repository), Vercel once a day (the Hobby plan allows no more), and
// any outside pinger sent the bearer. buyAndBurn is anyone's to call and the
// contract meters itself, so extra clocks cannot double-spend: a second caller
// finds it not due and exits.
//
// CRON_SECRET gates it as it gates the sweep. BUYBACK_ADDRESS and
// BUYBACK_KEEPER_KEY come from the environment; without the key the script
// reads, reports, and exits 0, as it does on GitHub.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { sweepTriggerAllowed } from "../../dist/src/fleet/sweep-trigger.js";

const SCRIPT = join(process.cwd(), "scripts", "buyback-keeper.mjs");

const runKeeper = () =>
  new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { env: process.env, timeout: 170_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });

export async function GET(request) {
  if (!sweepTriggerAllowed(request, process.env.CRON_SECRET)) {
    return Response.json({ code: "unauthorized", retryable: false, reason: "cron_secret" }, { status: 401 });
  }
  const result = await runKeeper();
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
