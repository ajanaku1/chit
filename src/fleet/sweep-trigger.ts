/**
 * Who may start a scheduled sweep from outside. Vercel's cron sends
 * `Authorization: Bearer $CRON_SECRET` when that variable is set; the GitHub
 * Actions schedule sends the same. Without a configured secret the endpoint
 * stays open, as it was before the sweep became the place charges are queued.
 */
import { timingSafeEqual } from "node:crypto";

export const sweepTriggerAllowed = (request: Request, secret: string | undefined): boolean => {
  if (!secret) return true;
  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};
