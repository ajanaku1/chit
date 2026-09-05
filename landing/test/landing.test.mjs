import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicPath = new URL("../public/", import.meta.url);
const canonicalFavicon = new URL("../../brand/favicon.svg", import.meta.url);
const contractAddress = "0xD523A627030509021cC39B6d7C8543417D3E50D8";

async function source(name) {
  return readFile(new URL(name, publicPath), "utf8");
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

function colorInRule(css, selector, fallback) {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!match) return fallback;
  const declaration = match[1].match(/color:\s*var\(--([a-z-]+)\)/);
  return declaration ? cssVariable(css, `--${declaration[1]}`) : fallback;
}

function assertContrast(label, foreground, background, minimum) {
  const ratio = contrastRatio(foreground, background);
  assert.ok(
    ratio >= minimum,
    `${label} has ${ratio.toFixed(2)}:1 contrast; requires ${minimum}:1`,
  );
}

test("publishes the truthful Fleet Protocol story in semantic landmarks", async () => {
  const html = await source("index.html");

  assert.match(html, /<header[\s>]/);
  assert.match(html, /<main id="main-content"/);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.match(html, /A private line for a public fleet\./);
  assert.match(html, /ERC-4337/);
  assert.match(html, /iExec Nox/);
  assert.match(html, /Robinhood Chain/);
  assert.match(html, /migration is in progress/i);
  assert.match(html, /not affiliated with, sponsored by, or endorsed by Robinhood/i);
  assert.match(html, /https:\/\/chit-kohl\.vercel\.app\//);
  assert.match(html, /target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /public[^.]{0,80}visible/i);
  assert.match(html, /operator[^.]{0,80}(mapping|relationship)/i);
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
  assert.match(html, /class="brand-lockup"/);
  assert.match(html, new RegExp(`<code id="contract-address">${contractAddress}</code>`));
  assert.match(html, /<button id="copy-contract-address" type="button">Copy<\/button>/);
  assert.match(html, /<span id="copy-contract-status" class="sr-only" role="status" aria-live="polite"><\/span>/);
});

test("copies the complete contract address with inline button feedback", async () => {
  const script = await source("main.js");

  assert.match(script, /navigator\.clipboard\.writeText\(contractAddress\.textContent \?\? ""\)/);
  assert.match(script, /copy-contract-status/);
  assert.match(script, /button\.textContent\s*=\s*"Copied"/);
  assert.match(script, /status\.textContent\s*=\s*"Contract address copied\."/);
  assert.match(script, /button\.textContent\s*=\s*"Copy"/);
  assert.match(script, /Copy failed\. Try again\./);
  assert.match(script, /classList\.add\("error"\)/);
  assert.match(script, /classList\.remove\("error"\)/);
});

test("keeps contract-copy status screen-reader-only without a visible grid row", async () => {
  const css = await source("style.css");

  assert.doesNotMatch(css, /grid-template-areas:\s*"label address copy"\s*"status status status"/);
  assert.doesNotMatch(css, /#copy-contract-status\s*\{/);
  assert.doesNotMatch(css, /#copy-contract-status\.error/);
});

test("keeps the mobile contract group cohesive in a header grid", async () => {
  const [html, css] = await Promise.all([source("index.html"), source("style.css")]);

  assert.match(html, /class="brand-lockup"[\s\S]*?<\/div>\s*<nav[\s\S]*?<\/nav>\s*<div class="contract-row"/);
  assert.match(css, /\.header-inner\s*\{[^}]*display:\s*grid[^}]*grid-template-areas:\s*"brand nav"\s*"contract contract"/);
  assert.match(css, /\.contract-row\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto/);
  assert.doesNotMatch(css, /#contract-address\s*\{[^}]*flex:\s*1\s+1\s+100%/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.contract-row \{ font-size: 10px; \}/);
});

test("keeps the desktop contract group compact beneath the brand", async () => {
  const css = await source("style.css");

  assert.match(css, /\.contract-row\s*\{[^}]*justify-self:\s*start/);
  assert.match(css, /\.contract-row\s*\{[^}]*width:\s*fit-content/);
  assert.match(css, /\.contract-row\s*\{[^}]*max-width:\s*100%/);
});

test("keeps external assets and unsupported product claims out of the landing", async () => {
  const html = await source("index.html");

  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+https?:\/\//i);
  assert.doesNotMatch(html, /anonymous trades|hidden trades|fleet-wide unlinkability|migration complete|Chit is live on Robinhood/i);
});

test("implements once-only, reduced-motion-safe explanation motion", async () => {
  const [css, js] = await Promise.all([source("style.css"), source("main.js")]);

  assert.match(css, /--ease-out:\s*cubic-bezier\(0\.23,\s*1,\s*0\.32,\s*1\)/);
  assert.match(css, /--ease-in-out:\s*cubic-bezier\(0\.77,\s*0,\s*0\.175,\s*1\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /clip-path/);
  assert.match(css, /@media\s*\(hover:\s*hover\)\s*and\s*\(pointer:\s*fine\)/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /unobserve/);
  assert.doesNotMatch(`${css}\n${js}`, /transition:\s*all|scale\(0\)|ease-in(?:[;, )]|$)|scroll-behavior:\s*smooth|\blinear\b/i);
});

test("uses WCAG-compliant text and focus colors on paper surfaces", async () => {
  const css = await source("style.css");
  const paper = cssVariable(css, "--paper");
  const softPaper = cssVariable(css, "--soft-paper");
  const ink = cssVariable(css, "--ink");
  const softEyebrow = colorInRule(css, "\\.prototype \\.eyebrow, \\.controls \\.eyebrow", cssVariable(css, "--muted-ink"));
  const hoverText = colorInRule(css, ":is\\(nav a, \\.text-action, \\.external-link\\):is\\(:hover\\)", ink);
  const focusIndicator = colorInRule(css, "a:focus-visible", ink);

  assertContrast("12px eyebrow text on soft paper", softEyebrow, softPaper, 4.5);
  assertContrast("Hover text on paper", hoverText, paper, 4.5);
  assertContrast("Hover text on soft paper", hoverText, softPaper, 4.5);
  assertContrast("Focus indicator on paper", focusIndicator, paper, 3);
  assertContrast("Focus indicator on soft paper", focusIndicator, softPaper, 3);
});
