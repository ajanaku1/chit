import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The old landing is retired: the site a reader meets is web/, served at chit.tools,
 * and this deploy serves the app and nothing else. What is left here is what the app
 * and the bot still need — the bot's banners, which the API function bundles, and
 * progress.json, which the site reads through its own route.
 */

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const gone = async (path) => {
  try {
    await access(join(repoRoot, path));
    return false;
  } catch {
    return true;
  }
};

test("the old landing and burn pages are gone, and nothing serves them", async () => {
  for (const path of ["landing/public/index.html", "landing/public/burn/index.html", "landing/public/main.js", "landing/public/style.css"]) {
    assert.equal(await gone(path), true, `${path} is still here; the site is web/ now`);
  }
});

test("what the app and the bot still need is kept", async () => {
  for (const path of ["landing/public/progress.json", "landing/public/bot"]) {
    assert.equal(await gone(path), false, `${path} was removed, but it is still read (the bot's banners, the site's progress route)`);
  }
});

test("this host sends a visitor at its root to the site, and does not claim the root for itself", async () => {
  const vercel = JSON.parse(await readFile(join(repoRoot, "vercel.json"), "utf8"));
  const root = (vercel.redirects ?? []).find((r) => r.source === "/");
  assert.ok(root, "the root of the app host must redirect");
  assert.equal(root.destination, "https://chit.tools");
  assert.equal(root.permanent, false, "temporary: a permanent redirect is cached hard and this host may serve its own root later");
});
