import { NextResponse } from "next/server";

/*
 * The live buyback reading, passed through from the host that reads the chain,
 * cached for half a minute.
 *
 * It used to name chit.tools outright, which was that host. Since the site and the
 * service were split it is this site, so the route fetched itself: Next served the
 * first answer it ever got and refreshed it against a copy of itself forever after.
 * The page said "25 h ago" for a day while the chain was minutes old and nothing
 * errored, because a cache serving a stale truth looks exactly like a fresh one.
 * FLEET_API_ORIGIN names the service, as it does for the rewrites, and a self-fetch
 * is refused outright rather than quietly frozen.
 */
export const revalidate = 30;

const SERVICE = (process.env.FLEET_API_ORIGIN ?? "").replace(/\/+$/, "");

export async function GET() {
  try {
    if (SERVICE === "") throw new Error("FLEET_API_ORIGIN is not set: this site does not read the chain itself");
    const r = await fetch(`${SERVICE}/api/burn`, { next: { revalidate: 30 }, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    const events = Array.isArray(d.events) ? d.events : [];
    return NextResponse.json({
      burnedOfMinted: d.burnedOfMinted,
      burned: d.totals?.burned,
      buys: d.totals?.buys,
      received: d.totals?.received,
      spent: d.totals?.spent,
      balance: d.balance,
      supply: d.supply,
      nextDueAt: d.next?.dueAt,
      nextSpend: d.next?.spend,
      readAt: d.readAt,
      stale: Boolean(d.stale),
      explorer: d.explorer,
      events: events.slice(-12).reverse(),
    });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
