import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Design contracts for the app redesign (design-app-redesign.md). The look is
 * judged on screen; these pin the rules a restyle could quietly break.
 */

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(appRoot);
const read = (path: string): Promise<string> => readFile(join(appRoot, path), "utf8");

const PAGES = ["fleet.html", "fleet-dashboard.html", "balance.html", "fleet-privacy.html"] as const;
const NEW_STYLES = ["src/styles/tokens.css", "src/styles/components.css", "src/styles/pages.css"] as const;

const cssColor = (css: string, name: string): string => {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css);
  assert.ok(match, `${name} is not a six-digit colour token`);
  return match[1]!.toLowerCase();
};

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** Innermost `selector { body }` pairs, comments stripped; nested @media rules included. */
const rules = (css: string): Array<[string, string]> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!]);

test("the app's palette is the landing's, token for token", async () => {
  const [landing, tokens] = await Promise.all([
    readFile(join(repoRoot, "landing/public/style.css"), "utf8"),
    read("src/styles/tokens.css"),
  ]);
  for (const name of ["--coral", "--coral-lift", "--coral-deep", "--paper", "--soft-paper", "--ink", "--muted-ink", "--surface-top", "--surface-bottom"]) {
    assert.equal(cssColor(tokens, name), cssColor(landing, name), `${name} drifted from the landing`);
  }
});

test("fleet.css layers the new styles over the old ones", async () => {
  const css = await read("fleet.css");
  assert.match(css, /^@layer (?:legacy, )?tokens, components, pages;/, "the layer order is not declared first");
  for (const file of ["tokens", "components", "pages"]) {
    assert.match(css, new RegExp(`@import url\\("\\./styles/${file}\\.css"\\) layer\\(${file}\\);`), `styles/${file}.css is not imported`);
  }
});

test("the build ships the layered stylesheets", async () => {
  const build = await read("build.mjs");
  for (const file of ["tokens", "components", "pages"]) {
    assert.match(build, new RegExp(`"\\./src/styles/${file}\\.css"[\\s\\S]*?"styles/${file}\\.css"`), `styles/${file}.css is not copied`);
  }
});

test("text on the ink surface is readable", async () => {
  const tokens = await read("src/styles/tokens.css");
  const [paper, softPaper, ink, coral] = ["--paper", "--soft-paper", "--ink", "--coral"].map((name) => cssColor(tokens, name));
  assert.ok(contrast(paper!, ink!) >= 4.5, "body text on ink");
  assert.ok(contrast(softPaper!, ink!) >= 4.5, "secondary text on ink");
  assert.ok(contrast(coral!, ink!) >= 3, "coral accent on ink");
  assert.ok(contrast(ink!, paper!) >= 4.5, "ink label on a paper button");
});

test("the app is dark-only: no theme switch, ink browser chrome", async () => {
  for (const page of PAGES) {
    const html = await read(page);
    assert.doesNotMatch(html, /theme-toggle/, `${page} still offers a theme switch`);
    assert.match(html, /<meta name="theme-color" content="#171513" \/>/, `${page} paints light browser chrome`);
  }
  for (const script of ["src/fleet/page-shared.ts", "src/fleet-page.ts", "src/fleet-dashboard.ts", "src/balance-page.ts", "src/fleet-privacy.ts"]) {
    assert.doesNotMatch(await read(script), /initTheme/, `${script} still wires the theme switch`);
  }
  assert.doesNotMatch(await read("fleet.css"), /data-theme|prefers-color-scheme/, "the old stylesheet still switches themes");
});
