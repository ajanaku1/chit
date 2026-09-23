import { NextResponse } from "next/server";

/* The live buyback reading, passed through from chit.tools (which reads the chain), cached for half a minute. */
export const revalidate = 30;

export async function GET() {
  try {
    const r = await fetch("https://chit.tools/api/burn", { next: { revalidate: 30 }, headers: { accept: "application/json" } });
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
