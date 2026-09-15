// Serves the latest build progress to the landing without sending visitors to
// GitHub. The file is committed to the public mirror on every push to main
// (.github/workflows/progress.yml); this reads it server-side and caches it at
// the edge for five minutes, so the landing follows the repo and a visitor's
// browser only ever talks to chit.tools. The rule is PROGRESS.md.
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
