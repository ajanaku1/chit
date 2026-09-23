import { NextResponse } from "next/server";

/* The session account factory for this build's chain, read by the Sessions page at ./session-target.json. */
export const dynamic = "force-static";
export function GET() {
  return NextResponse.json(JSON.parse(process.env.NEXT_PUBLIC_SESSION_TARGET ?? "{}"));
}
