import { NextResponse } from "next/server";

/* Where the build stands, as the repo records it on every push to main. */
export const revalidate = 300;

export async function GET() {
  try {
    const r = await fetch("https://chit.tools/progress.json", { next: { revalidate: 300 } });
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    return NextResponse.json({ tasks: d.tasks, stages: d.stages, commits: d.commits, committedAt: d.committedAt });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
