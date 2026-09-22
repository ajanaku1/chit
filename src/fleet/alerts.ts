/**
 * The service's alert sink (T048, FR-023).
 *
 * The outside monitor watches what the chain shows: a charge left unposted, the
 * operator's balance, the roles, the pool's own arithmetic. Two things it
 * cannot see happen inside the service and are reported from here instead: a
 * sweep that failed, and a withdrawal that was refused (T049).
 *
 * One chat for everything, split by who acts, the same vocabulary the monitor
 * uses (`Acts` in monitor.ts): operations, the money path, or both. The chat is
 * MONITOR_CHAT_ID and never TELEGRAM_CHAT_ID, which is the public group.
 *
 * FR-023's three timescales are the `timescale` field. `immediately` and
 * `four-hours` both go out at once — the requirement is an upper bound on when
 * an operator learns of it, and the service has no reason to sit on either —
 * and the line says which class it is, so a reader can tell "act now" from
 * "act today". `daily` is held in the store and flushed as one digest by the
 * first sweep past the digest hour. An alert that names no timescale is
 * treated as immediate: FR-023 says an unclassifiable failure belongs to the
 * faster class.
 *
 * Nothing here throws at its caller. An alert is raised from inside the path
 * that is already failing; a sink that threw would turn a refused withdrawal
 * into a 503 and lose the reason with it.
 */
import type { Acts } from "./monitor.js";
import type { StorePort } from "./store.js";

export type Timescale = "immediately" | "four-hours" | "daily";

export type Alert = {
  /** The check's name, as the monitor names its findings: `sweep-failed`, `withdrawal-refused`. */
  what: string;
  summary: string;
  acts: Acts;
  /** Absent means immediate (FR-023's faster class). */
  timescale?: Timescale;
  detail?: readonly string[];
};

export type AlertSink = {
  /** Sends it, or holds it for the digest. Never throws. */
  raise(alert: Alert): Promise<void>;
  /** Sends the day's held lines as one digest, once a day, whichever instance gets there first. Never throws. */
  flushDaily(): Promise<void>;
};

export type AlertDeps = {
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  store: StorePort;
  now?: () => Date;
  log?: (line: string) => void;
};

const MARK: Record<Timescale, string> = { "immediately": "NOW", "four-hours": "4H", "daily": "DAY" };

/** One line per alert, in the monitor's shape: when it must be acted on, what, who acts, and the reason. */
export const alertLine = (alert: Alert): string =>
  [`${MARK[alert.timescale ?? "immediately"]} ${alert.what} (${alert.acts}): ${alert.summary}`, ...(alert.detail ?? []).map((d) => `    ${d}`)].join("\n");

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

/** The digest hour is the monitor's, so the two digests of a day sit together. */
const digestHour = (env: AlertDeps["env"]): number => Number(env["MONITOR_DIGEST_HOUR_UTC"] || 7);

export const createAlertSink = (deps: AlertDeps): AlertSink => {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.error(line));
  const chainId = deps.env["FLEET_CHAIN_ID"] ?? "?";

  const send = async (text: string): Promise<void> => {
    const [token, chat] = [deps.env["TELEGRAM_BOT_TOKEN"], deps.env["MONITOR_CHAT_ID"]];
    if (!token || !chat) {
      log(`alert not sent (TELEGRAM_BOT_TOKEN and MONITOR_CHAT_ID are not both set): ${text}`);
      return;
    }
    try {
      const response = await deps.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
      if (!response.ok) log(`alert not sent (telegram answered ${response.status}): ${text}`);
    } catch (error) {
      log(`alert not sent (${firstLine(error)}): ${text}`);
    }
  };

  const header = (what: string): string => `Chit fleet service · ${what} · chain ${chainId}`;

  return {
    async raise(alert) {
      const line = alertLine(alert);
      if (alert.timescale === "daily") {
        try {
          await deps.store.alerts.hold(line, now().getTime());
          return;
        } catch (error) {
          // Held nowhere is said now: an alert kept in a store that cannot be
          // reached is an alert nobody gets, and the faster class is the rule.
          log(`alert not held (${firstLine(error)}): sending it now instead`);
        }
      }
      await send([header("alert"), line].join("\n"));
    },

    async flushDaily() {
      try {
        const at = now();
        if (at.getUTCHours() < digestHour(deps.env)) return;
        // The day is claimed with the nonce burn every instance already shares,
        // so the digest goes out once however many instances sweep that hour.
        const day = at.toISOString().slice(0, 10);
        const tomorrow = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 2);
        if (!(await deps.store.burnNonce(`alerts:daily:${day}`, tomorrow, at.getTime()))) return;
        const held = await deps.store.alerts.takeHeld();
        // Silence when nothing was held: the monitor's own digest is the daily
        // heartbeat, and a second empty one every morning would only be noise.
        if (held.length === 0) return;
        await send([header("daily digest"), ...held].join("\n"));
      } catch (error) {
        log(`daily alert digest not sent: ${firstLine(error)}`);
      }
    },
  };
};
