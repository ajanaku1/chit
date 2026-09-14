import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("does not link into the app, which is not public", async () => {
  const html = await source("index.html");

  // The Fleet app runs locally while it is in private testing. A link here
  // would publish the Control Room and Balance pages to anyone who lands.
  assert.doesNotMatch(html, /href="\/app/);

  // Links that do leave the page must leave it safely.
  for (const link of html.match(/<a [^>]*href="https?:[^>]*>/g) ?? []) {
    assert.match(link, /target="_blank"/, `${link} opens in place`);
    assert.match(link, /rel="noopener noreferrer"/, `${link} lacks rel=noopener noreferrer`);
  }
  assert.doesNotMatch(html, /href="[^"]*(fleet|balance|dashboard)[^"]*\.html"/i);

  // And the calls to action are inert until it is public.
  // Every call to action is inert. The only live controls are the contract
  // copy and the in-page morph cue, neither of which leaves the landing.
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
  assert.match(html, new RegExp(`<code id="contract-address">${contractAddress}</code>`));
  assert.match(html, /<button id="copy-contract-address" type="button">Copy<\/button>/);
  assert.match(html, /<span id="copy-contract-status" class="sr-only" role="status" aria-live="polite"><\/span>/);
});

test("copies the complete contract address with inline button feedback", async () => {
  const script = await source("main.js");

  assert.match(script, /navigator\.clipboard\.writeText\(contractAddress\.textContent \?\? ""\)/);
  assert.match(script, /copy-contract-status/);
  assert.match(script, /textContent = "Copied"/);
  assert.match(script, /textContent = "Contract address copied\."/);
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
