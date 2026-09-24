import { NextResponse } from "next/server";

/* Where the build stands, as the repo records it on every push to main. */
export const revalidate = 300;

const SERVICE = (process.env.FLEET_API_ORIGIN ?? "").replace(/\/+$/, "");

export async function GET() {
  try {
    // The same rule as the burn route: the file is served by the host that holds it,
    // and naming chit.tools here now names this site, which does not serve it at all.
    if (SERVICE === "") throw new Error("FLEET_API_ORIGIN is not set: this site does not hold progress.json");
    const r = await fetch(`${SERVICE}/progress.json`, { next: { revalidate: 300 } });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    return NextResponse.json({ tasks: d.tasks, stages: d.stages, commits: d.commits, committedAt: d.committedAt });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
