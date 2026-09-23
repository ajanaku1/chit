import { NextResponse } from "next/server";

/* The chain this build is for, read by the app's logic at ./chain-target.json exactly as chit-fleet's build writes it. */
export const dynamic = "force-static";
export function GET() {
  return NextResponse.json(JSON.parse(process.env.NEXT_PUBLIC_CHAIN_TARGET ?? "{}"));
}
