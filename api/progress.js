// Serves the public mirror's copy of the build progress without sending
// visitors to GitHub: read server-side, cached at the edge for five minutes.
// The Vercel build computes the deploy's own progress.json as the landing's
// fallback when this is unreachable. The rule is PROGRESS.md.
//
// Plain JS on purpose: see api/fleet/campaign.js.

const SOURCE = "https://raw.githubusercontent.com/ajanaku1/chit-app/main/landing/public/progress.json";

export async function GET() {
  const upstream = await fetch(SOURCE, { headers: { accept: "application/json" } });
  if (!upstream.ok) {
    return new Response(JSON.stringify({ error: "progress unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return new Response(await upstream.text(), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
