import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Rewritten 2026-09-13, when the landing moved to the two-screen morph design.
 *
 * What changed: the assertions that pinned the previous page's markup — the
 * six explanatory sections, the .header-inner grid areas, the .prototype and
 * .controls eyebrow selectors — describe a page that no longer exists.
 *
 * What deliberately did NOT change: every assertion that protects a claim or a
 * disclosure. The honest framing, the operator admission, the non-affiliation
 * line, the overclaim blocklist and the no-third-party-assets rule are all
 * still here, and two of them are stricter than before.
 */

const publicPath = new URL("../public/", import.meta.url);
const canonicalFavicon = new URL("../../brand/favicon.svg", import.meta.url);
const contractAddress = "0xD523A627030509021cC39B6d7C8543417D3E50D8";

async function source(name) {
  return readFile(new URL(name, publicPath), "utf8");
}

/** Rendered text, so copy assertions survive the markup being re-laid-out. */
function text(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hexChannel(value) {
  return Number.parseInt(value, 16) / 255;
}

function linearChannel(value) {
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const channels = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)]
    .map(hexChannel)
    .map(linearChannel);

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)]
    .sort((left, right) => right - left);

  return (lighter + 0.05) / (darker + 0.05);
}

function cssVariable(css, name) {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(match, `Expected ${name} to be a six-digit color token`);
  return match[1];
}

function assertContrast(label, foreground, background, minimum) {
  const ratio = contrastRatio(foreground, background);
  assert.ok(
    ratio >= minimum,
    `${label} has ${ratio.toFixed(2)}:1 contrast; requires ${minimum}:1`,
  );
}

test("publishes the truthful Fleet story in semantic landmarks", async () => {
  const html = await source("index.html");
  const copy = text(html);

  assert.match(html, /<header[\s>]/);
  assert.match(html, /<main id="main-content"/);
  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);

  assert.match(copy, /A private line for a public fleet\./);
  assert.match(copy, /ERC-4337/);
  assert.match(copy, /Robinhood Chain/);
});

test("states the privacy boundary honestly and admits what the operator sees", async () => {
  const copy = text(await source("index.html"));

  // The FR-015 claim Stage 2 earns, now that the pool serves in production.
  assert.match(copy, /Your main wallet never funds your fleet/i);
  assert.match(copy, /no transaction links the two/i);

  // Trades stay public. This is the half a reader is most likely to miss.
  assert.match(copy, /Trades stay public/i);
  assert.match(copy, /only the funding relationship is withheld/i);

  // The operator can still link a deposit to a fleet. Never drop this.
  assert.match(copy, /operator[^.]{0,80}(link|mapping|relationship)/i);

  // Private, not anonymous — the FR-015 framing, in its denied form.
  assert.match(copy, /Private, not anonymous/i);

  // Independence from the chains and venues named on the page.
  assert.match(copy, /not affiliated with, sponsored by, or endorsed by Robinhood/i);
});

test("keeps unsupported product claims off the landing", async () => {
  const copy = text(await source("index.html"));

  assert.doesNotMatch(
    copy,
    /anonymous trades|hidden trades|untraceable|fleet-wide unlinkability|migration complete|Chit is live on Robinhood/i,
  );
  // "anonymous" only ever appears denied.
  for (const match of copy.match(/.{0,24}anonymous/gi) ?? []) {
    assert.match(match, /not anonymous/i, `"${match.trim()}" claims anonymity`);
  }
});

test("links into the app, and says the app is testnet", async () => {
  const html = await source("index.html");

  // The end-to-end flow works on testnet (2026-09-16), so the app buttons go
  // to the app itself: the wizard, on this host, in the same tab.
  assert.match(html, /<a class="btn-nav" href="\/app\/fleet\.html">Launch app<\/a>/);
  assert.match(html, /<a class="btn btn--solid" href="\/app\/fleet\.html">Open the app<\/a>/);
  assert.doesNotMatch(html, /aria-controls="progress"/, "a button still opens the progress sheet");
  assert.doesNotMatch(html, /private testing|runs locally/i, "the landing still calls the app private");
  assert.match(html, /<p class="hero__pending"[^>]*>[^<]*testnet[^<]*<\/p>/i, "the hero does not say the app is testnet");

  // Links that do leave the page must leave it safely.
  for (const link of html.match(/<a [^>]*href="https?:[^>]*>/g) ?? []) {
    assert.match(link, /target="_blank"/, `${link} opens in place`);
    assert.match(link, /rel="noopener noreferrer"/, `${link} lacks rel=noopener noreferrer`);
  }
  // The app's entry is the wizard; the Control Room and Balance pages are
  // reached from inside the app, with a wallet, not from the landing.
  assert.doesNotMatch(html, /href="[^"]*(balance|dashboard)[^"]*\.html"/i);

  // Buttons other than the contract copy and the morph cue stay inert: what
  // leaves the landing is a link, so it works without script.
  for (const button of html.match(/<button[^>]*>/g) ?? []) {
    if (/id="copy-contract-address"|class="morph-cue"/.test(button)) continue;
    assert.match(button, /\bdisabled\b/, `${button} is still clickable`);
  }
});

test("loads no third-party assets", async () => {
  const html = await source("index.html");

  // A privacy product must not hand every visitor's IP to a font CDN.
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+https?:\/\//i);
});

test("uses the canonical Chit mark and exposes a copyable contract address", async () => {
  const [html, logo, favicon, canonical] = await Promise.all([
    source("index.html"),
    source("logo.svg"),
    source("favicon.svg"),
    readFile(canonicalFavicon, "utf8"),
  ]);

  assert.equal(logo, canonical);
  assert.equal(favicon, canonical);

  // Declared, not merely present: the previous revision served favicon.svg
  // while the page linked nothing, so browsers fell back to a 404 favicon.ico.
  assert.match(html, /<link rel="icon" href="favicon\.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="icon" href="favicon\.ico"/);
  assert.match(html, /<link rel="apple-touch-icon" href="apple-touch-icon\.png">/);
  assert.match(html, /class="brand-lockup"/);
  const code = /<code id="contract-address" title="([^"]+)">([\s\S]*?)<\/code>/.exec(html);
  assert.ok(code, "no contract address");
  assert.equal(code[1], contractAddress, "hovering the address does not show all of it");
  // Shown shortened, but the text is whole: copying, selecting and screen readers get every character.
  assert.equal(code[2].replace(/<[^>]+>/g, ""), contractAddress);
  assert.match(code[2], /<span class="sr-only">/);
  assert.match(html, /<span class="contract-row__label">CHIT token<\/span>/);
  assert.match(html, /<button id="copy-contract-address" type="button" aria-label="Copy CHIT token address">[\s\S]*?<span class="contract-row__action">Copy<\/span><\/button>/);
  assert.match(html, /<span id="copy-contract-status" class="sr-only" role="status" aria-live="polite"><\/span>/);
});

test("copies the complete contract address with inline button feedback", async () => {
  const script = await source("main.js");

  assert.match(script, /navigator\.clipboard\.writeText\(contractAddress\.textContent \?\? ""\)/);
  assert.match(script, /copy-contract-status/);
  assert.match(script, /textContent = "Copied"/);
  assert.match(script, /textContent = "CHIT token address copied\."/);
  assert.match(script, /copyLabel\.textContent = "Copied"/, "the copy result replaces the button's icons instead of its label");
  assert.match(script, /textContent = "Copy"/);
  assert.match(script, /Copy failed\. Try again\./);
  assert.match(script, /classList\.add\("error"\)/);
  assert.match(script, /classList\.remove\("error"\)/);
});

test("keeps the contract group cohesive and screen-reader-only where it should be", async () => {
  const css = await source("style.css");

  assert.match(css, /\.masthead\s*\{[^}]*grid-template-areas:\s*"brand action"\s*"contract contract"/);
  assert.match(css, /\.contract-row\s*\{[^}]*justify-self:\s*start/);
  assert.match(css, /\.contract-row\s*\{[^}]*width:\s*fit-content/);
  assert.match(css, /\.contract-row\s*\{[^}]*max-width:\s*100%/);
  assert.match(css, /\.contract-row\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
  assert.match(css, /\.sr-only\s*\{/);
  assert.doesNotMatch(css, /#copy-contract-status\s*\{/);
});

test("implements once-only, reduced-motion-safe motion", async () => {
  const [css, js] = await Promise.all([source("style.css"), source("main.js")]);

  assert.match(css, /--ease-out:\s*cubic-bezier\(0\.23,\s*1,\s*0\.32,\s*1\)/);
  assert.match(css, /--ease-in-out:\s*cubic-bezier\(0\.77,\s*0,\s*0\.175,\s*1\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /clip-path/);
  assert.match(css, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /unobserve/);

  // Motion quality. The previous revision also banned the bare token "linear",
  // which caught every linear-gradient in the file rather than any easing. The
  // ban is narrowed to the things that actually read as cheap: all-property
  // transitions, collapse-to-nothing scales, ease-in, and smooth scrolling.
  // Linear easing itself stays legal for the opacity-only load ramp, which is
  // the one place it is correct.
  assert.doesNotMatch(
    `${css}\n${js}`,
    /transition:\s*all|scale\(0\)|ease-in(?:[;, )]|$)|scroll-behavior:\s*smooth/i,
  );
});

test("uses WCAG-compliant text colors on the ink surface", async () => {
  const css = await source("style.css");
  const paper = cssVariable(css, "--paper");
  const softPaper = cssVariable(css, "--soft-paper");
  const ink = cssVariable(css, "--ink");
  const coral = cssVariable(css, "--coral");

  // The page is now an ink surface with paper type, so the pairs under test
  // are the ones a reader actually sees.
  assertContrast("Body text on ink", paper, ink, 4.5);
  assertContrast("Secondary text on ink", softPaper, ink, 4.5);
  assertContrast("Coral accent on ink", coral, ink, 3);
  assertContrast("Ink label on a paper button", ink, paper, 4.5);
});

/**
 * Every link lands somewhere. "Read the boundary" once pointed at #boundary,
 * which nothing on the page carried, so clicking it did nothing.
 */
test("every link on the landing reaches a page or an element that exists", async () => {
  const html = await source("index.html");
  for (const [, target] of html.matchAll(/href="(#[^"]*|\/[^"]*)"/g)) {
    if (target.startsWith("#")) {
      assert.match(html, new RegExp(`id="${target.slice(1)}"`), `${target} points at nothing on the page`);
    } else if (target !== "/") {
      await assert.doesNotReject(access(new URL(`../..${target}`, import.meta.url)), `${target} does not exist`);
    }
  }
  // The app buttons are real links now; the check above holds them to a page
  // that exists, like every other link.
});

/**
 * Each Learn More opens a limit sheet on screen B. The sheets explain the
 * contract, so every identifier they cite must exist in FleetPool.sol; a
 * constant renamed or a revert removed fails here before it misleads a reader.
 */
test("every Learn More opens a limit sheet whose contract citations are real", async () => {
  const html = await source("index.html");
  const pool = await readFile(new URL("../../contracts/fleet/FleetPool.sol", import.meta.url), "utf8");

  const triggers = [...html.matchAll(/<a class="learn-more" href="#(limit-[a-z]+)" aria-controls="(limit-[a-z]+)"/g)];
  assert.equal(triggers.length, 3);
  for (const [, href, controls] of triggers) {
    assert.equal(href, controls);
    assert.match(html, new RegExp(`<section class="limit limit--[a-z]+" id="${href}" aria-labelledby="${href}-title"`));
  }

  const sheets = html.match(/<section class="limit limit--[a-z]+" id="limit-[\s\S]*?<\/section>/g) ?? [];
  assert.equal(sheets.length, 3);
  for (const sheet of sheets) {
    for (const [, cited] of sheet.matchAll(/<code>([^<]+)<\/code>/g)) {
      for (const ident of cited.replace(/&[a-z]+;/g, " ").match(/[A-Za-z_]{3,}/g) ?? []) {
        if (["ether", "hours"].includes(ident)) continue;
        assert.match(pool, new RegExp(`\\b${ident}\\b`), `"${ident}" is not in FleetPool.sol`);
      }
    }
    // Both ways out stay on the landing.
    assert.match(sheet, /class="limit__close" href="#the-numbers"/);
    assert.match(sheet, /class="limit__next" href="#limit-[a-z]+"/);
  }
  assert.match(html, /<section class="screen screen--metrics" id="the-numbers"/);
});

/**
 * Read the boundary opens the boundary sheet and stays on the landing. The
 * progress sheet is still reachable at #progress and carries no hand-typed
 * number: every figure is rendered from progress.json, which
 * scripts/progress.mjs recomputes from the task lists (PROGRESS.md).
 */
test("the boundary button opens its sheet, and the progress sheet types no number", async () => {
  const [html, js] = await Promise.all([source("index.html"), source("main.js")]);

  assert.match(html, /<a class="btn btn--ghost" href="#boundary" aria-controls="boundary"[^>]*>Read the boundary<\/a>/);
  assert.match(html, /<div class="modal" id="progress" role="dialog" aria-modal="true" aria-labelledby="progress-title"/);
  assert.match(html, /<div class="modal" id="boundary" role="dialog" aria-modal="true" aria-labelledby="boundary-title"/);

  // Meet the dev still has a home, and still leaves the page safely.
  assert.match(html, /<nav class="nav"[\s\S]*?href="https:\/\/ajanaku1\.github\.io\/bambam\/meet-the-dev"[\s\S]*?Meet the dev/);

  // The progress sheet's figures are slots, not literals.
  const progress = html.match(/<div class="modal" id="progress"[\s\S]*?<\/div>\s*<!-- Read the boundary/)[0];
  assert.match(progress, /data-dots="0" data-progress="percent"/);
  for (const slot of ["tasks", "stages", "specs", "open", "stamp"]) {
    assert.match(progress, new RegExp(`data-progress="${slot}"`), `no ${slot} slot`);
  }
  assert.doesNotMatch(text(progress), /\d+\s*(%|of \d+|\/ \d+)/, "a typed figure in the progress sheet");
  assert.match(js, /fetch\(url, \{ cache: 'no-store' \}\)/);
  assert.match(js, /'\/api\/progress', 'progress\.json'/);
});

test("progress.json matches the facts scripts/progress.mjs reads", () => {
  const check = spawnSync("node", [fileURLToPath(new URL("../../scripts/progress.mjs", import.meta.url)), "--check"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
});

/**
 * The build computes progress.json itself: scripts/assemble-site.mjs runs the
 * generator. A Vercel build only has the files .vercelignore lets through,
 * and that file dropped all of scripts/ but the assembler, and every
 * top-level .md, so the first build after the change died on
 * "Cannot find module '/vercel/path0/scripts/progress.mjs'" (21 September).
 * Nothing local can see that: the files are all there on a checkout. So this
 * asks git, which reads .vercelignore the way it reads .gitignore, which
 * tracked files a build never sees, and holds the list against what the
 * assembler runs and what the generator reads.
 */
test("the build has every file the progress generator needs", async (t) => {
  const repo = new URL("../../", import.meta.url);
  const specs = await readdir(new URL("specs/", repo)).catch(() => null);
  if (!specs) return t.skip("no specs/ here: the public mirror strips it");
  const dropped = spawnSync("git", ["ls-files", "-c", "-i", "--exclude-from=.vercelignore"], { cwd: fileURLToPath(repo), encoding: "utf8" });
  if (dropped.status !== 0) return t.skip("not a git checkout: nothing to ask");
  const unseen = new Set(dropped.stdout.split("\n"));

  const assemble = await readFile(new URL("scripts/assemble-site.mjs", repo), "utf8");
  const runs = [...assemble.matchAll(/["'](scripts\/[\w.-]+\.mjs)["']/g)].map((m) => m[1]);
  assert.ok(runs.includes("scripts/progress.mjs"), "the assembler runs the progress generator");

  const needed = ["scripts/assemble-site.mjs", ...runs, "README.md",
    ...specs.filter((name) => /^\d{3}-/.test(name)).flatMap((name) => [`specs/${name}/tasks.md`, `specs/${name}/spec.md`])];
  assert.deepEqual(needed.filter((file) => unseen.has(file)), [], "the build cannot run or read a file .vercelignore drops");
});
