/**
 * POST /api/fleet/alert-test: one line to the operator chat, on demand.
 *
 * The service's alerts only fire when something goes wrong, and its daily
 * digest stays silent when nothing was held, so a host with a wrong chat id or
 * bot token says nothing until the day it matters. This sends one line through
 * the same sink a real alert uses and answers with Telegram's status, so a
 * host's delivery is proved by a check rather than assumed from its settings.
 *
 * It needs `Authorization: Bearer $CRON_SECRET`, and unlike the sweep it never
 * runs open when that secret is unset: anyone able to post in the operator chat
 * could bury a real alert under noise.
 */
import { createAlertSink } from "./alerts.js";
import { createMemoryStore } from "./store.js";
import { sweepTriggerAllowed } from "./sweep-trigger.js";

type Env = Record<string, string | undefined>;

export const handleAlertTest = async (request: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> => {
  const secret = env["CRON_SECRET"];
  if (!secret || !sweepTriggerAllowed(request, secret)) {
    return Response.json({ code: "unauthorized", retryable: false, reason: "cron_secret" }, { status: 401 });
  }
  const chainId = env["FLEET_CHAIN_ID"] ?? "?";
  if (!env["TELEGRAM_BOT_TOKEN"] || !env["MONITOR_CHAT_ID"]) {
    return Response.json({ sent: false, reason: "not_configured", chainId }, { status: 503 });
  }

  // The sink swallows a failed send by design; this keeps Telegram's answer so the caller hears it.
  let telegramStatus: number | undefined;
  const recordingFetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await fetchImpl(...args);
    telegramStatus = response.status;
    return response;
  }) as typeof fetch;

  // An immediate alert never touches the store; the memory store only satisfies the sink's shape.
  const sink = createAlertSink({ env, fetch: recordingFetch, store: createMemoryStore() });
  await sink.raise({
    what: "alert-test",
    summary: `a test line sent by hand from ${new URL(request.url).host}, to prove this host reaches the operator chat`,
    acts: "operations",
    timescale: "immediately",
  });

  const sent = telegramStatus !== undefined && telegramStatus >= 200 && telegramStatus < 300;
  return Response.json({ sent, telegramStatus: telegramStatus ?? null, chainId }, { status: sent ? 200 : 502 });
};
