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

const PAGES = ["fleet.html", "fleet-dashboard.html", "balance.html", "fleet-privacy.html", "trade.html", "sessions.html"] as const;
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

const NAV: ReadonlyArray<readonly [string, string]> = [
  ["./balance.html", "Balance"],
  ["./fleet.html", "Set up"],
  ["./trade.html", "Trade"],
  ["./fleet-dashboard.html", "Control Room"],
  ["./fleet-privacy.html", "Boundary"],
  ["./sessions.html", "Sessions"],
];

test("every page wears the landing's masthead and the same nav", async () => {
  for (const page of PAGES) {
    const html = await read(page);
    assert.match(html, /<header class="masthead">/, `${page} has no masthead`);
    assert.match(html, /<a class="brand-lockup" href="\/" aria-label="Chit home">/, `${page} brand does not lead to the landing`);
    const nav = /<nav class="nav" id="fleet-nav" aria-label="Fleet pages">([\s\S]*?)<\/nav>/.exec(html);
    assert.ok(nav, `${page} has no fleet nav`);
    const links = [...nav[1]!.matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)];
    assert.deepEqual(links.map((m) => [m[1], m[3]]), NAV.map(([href, label]) => [href, label]), `${page} nav differs from the landing's labels`);
    assert.deepEqual(links.filter((m) => m[2]).map((m) => m[1]), [`./${page}`], `${page} marks the wrong page as current`);
    assert.match(html, /<button class="burger" type="button" aria-label="Menu" aria-expanded="false" aria-controls="fleet-nav">/, `${page} has no phone menu`);
    assert.doesNotMatch(html, /chain-mark|class="fleet-top"/, `${page} still carries the old header`);
  }
});

test("the phone menu opens and closes the nav it controls", async () => {
  const shared = await read("src/fleet/page-shared.ts");
  const menu = /export const initMenu[\s\S]*?\n\};/.exec(shared);
  assert.ok(menu, "no initMenu");
  assert.match(menu[0], /setAttribute\("aria-expanded", String\(open\)\)/);
  assert.match(menu[0], /dataset\["open"\] = String\(open\)/);
  assert.match(menu[0], /key === "Escape"/, "Escape does not close the menu");
});

// These two already pass; they guard the new markup.
test("no app page loads third-party assets", async () => {
  for (const page of PAGES) assert.doesNotMatch(await read(page), /<(?:script|link|img)[^>]+https?:\/\//i, page);
});

test("every link on every app page reaches a page or an element that exists", async () => {
  for (const page of PAGES) {
    const html = await read(page);
    for (const [, target] of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
      if (target === "/") continue;
      if (target!.startsWith("#")) {
        assert.match(html, new RegExp(`id="${target!.slice(1)}"`), `${page}: ${target} points at nothing`);
        continue;
      }
      assert.match(target!, /^\.\/[a-z-]+\.html$/, `${page}: unexpected link ${target}`);
      await assert.doesNotReject(access(join(appRoot, target!)), `${page}: ${target} does not exist`);
    }
  }
});

test("every page carries the contract row, the status pill and the non-affiliation line", async () => {
  for (const page of PAGES) {
    const html = await read(page);
    const code = /<code id="contract-address" title="([^"]+)">([\s\S]*?)<\/code>/.exec(html);
    assert.ok(code, `${page} has no contract row`);
    assert.equal(code[1], "0xD523A627030509021cC39B6d7C8543417D3E50D8", `${page}: hovering the address does not show all of it`);
    assert.equal(code[2]!.replace(/<[^>]+>/g, ""), code[1], `${page}: the shortened address no longer copies whole`);
    assert.match(code[2]!, /<span class="sr-only">/, `${page}: the address is not shortened in the middle`);
    assert.match(html, /<span class="contract-row__label">CHIT token<\/span>/, `${page} names the address with jargon`);
    assert.match(html, /<button id="copy-contract-address" type="button" aria-label="Copy CHIT token address">[\s\S]*?<span class="contract-row__action">Copy<\/span><\/button>/);
    assert.match(html, /<p id="pool-status" class="pill" role="status" hidden>/, `${page} has no hidden-by-default status pill`);
    assert.match(html, /not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap/, `${page} lacks the non-affiliation line`);
  }
});

test("the status pill reads the cached balance and never signs for one", async () => {
  const shared = await read("src/fleet/page-shared.ts");
  const pill = /export const initPoolStatus[\s\S]*?\n\};/.exec(shared);
  assert.ok(pill, "no initPoolStatus");
  assert.match(pill[0], /loadCachedBalance\(/);
  assert.doesNotMatch(pill[0], /readBalance|signedFleetApi/, "the pill must not cost a signature");
  assert.match(await read("src/fleet/balance-read.ts"), /dispatchEvent\(new CustomEvent\("chit-balance-read"/, "pages are never told a fresh balance arrived");
});

const LIVE_OR_HAPPENED = /pill|data-live|data-done|aria-current="step"|data-tone="ok"|\.delta|meter__fill|gauge/;

test("coral marks only what is live or has happened", async () => {
  for (const file of NEW_STYLES) {
    for (const [selector, body] of rules(await read(file))) {
      if (!/var\(--coral(?:-lift)?\)/.test(body)) continue;
      assert.match(selector, LIVE_OR_HAPPENED, `${file}: "${selector}" uses coral for something neither live nor done`);
    }
  }
});

test("primary actions are paper, as on the landing", async () => {
  const primary = rules(await read("src/styles/components.css")).find(([selector]) => selector === ".primary");
  assert.ok(primary, "no .primary rule");
  assert.match(primary[1], /background:\s*var\(--paper\)/);
  assert.match(primary[1], /color:\s*var\(--ink\)/);
});

test("hover effects only apply where there is a real pointer", async () => {
  for (const file of NEW_STYLES) {
    const unguarded = (await read(file)).replace(/@media \(hover: hover\) and \(pointer: fine\) \{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    assert.doesNotMatch(unguarded, /:hover/, `${file} has a hover effect outside the pointer guard`);
  }
});

test("a chosen size reads as chosen without borrowing coral, and field errors are deep-coral panels", async () => {
  const css = rules(await read("src/styles/components.css"));
  const pressed = css.find(([selector]) => selector === '.quickpick button[aria-pressed="true"]');
  assert.ok(pressed && /background:\s*var\(--paper\)/.test(pressed[1]), "the chosen size is not paper");
  const error = css.find(([selector]) => selector === ".field-error");
  assert.ok(error && /background:\s*var\(--coral-deep\)/.test(error[1]), "field errors are not deep-coral panels");
});

test("the three surfaces exist, and glass is real glass", async () => {
  const css = rules(await read("src/styles/components.css"));
  const glass = css.find(([selector]) => selector === ".card-glass");
  assert.ok(glass && /backdrop-filter:\s*blur\(/.test(glass[1]), ".card-glass has no blur");
  assert.ok(css.some(([selector]) => selector === ".card-warm"), "no .card-warm");
  assert.ok(css.some(([selector]) => /(^|,\s*)\.card-solid\b/.test(selector)), "no .card-solid");
});

test("errors are deep-coral panels, never the live accent", async () => {
  const error = rules(await read("src/styles/components.css")).find(([selector]) => selector === '.status-banner[data-tone="error"]');
  assert.ok(error && /background:\s*var\(--coral-deep\)/.test(error[1]));
});

test("motion follows the landing's rules", async () => {
  const [tokens, components, pages, motion] = await Promise.all([read("src/styles/tokens.css"), read("src/styles/components.css"), read("src/styles/pages.css"), read("src/fleet/motion.ts")]);
  assert.match(tokens, /--ease-out:\s*cubic-bezier\(0\.23,\s*1,\s*0\.32,\s*1\)/);
  assert.match(tokens, /--ease-in-out:\s*cubic-bezier\(0\.77,\s*0,\s*0\.175,\s*1\)/);
  const css = `${components}\n${pages}`;
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "no still version for reduced motion");
  assert.match(motion, /IntersectionObserver/);
  assert.match(motion, /unobserve/, "reveals must happen once");
  assert.doesNotMatch(`${css}\n${motion}`, /transition:\s*all|scale\(0\)|ease-in(?:[;, )]|$)|scroll-behavior:\s*smooth/im);
});

test("the Balance page leads with a glass hero, the headroom meter and the three limits", async () => {
  const html = await read("balance.html");
  const { DRAW_CAP, toEth } = await import("../src/fleet/balance.js");
  assert.match(html, /<section class="wstep card-glass" aria-labelledby="balance-h" data-reveal>/);
  assert.match(html, /id="headroom-meter" role="meter"/);
  assert.match(html, new RegExp(`data-led="${toEth(DRAW_CAP).replace(".", "\\.")}" data-unit="ETH"`), "the page's draw cap drifted from DRAW_CAP");
  assert.match(html, /data-led="15" data-unit="min"/);
  assert.match(html, /data-led="24" data-unit="h"/);
  assert.match(html, /<section id="exit-card" class="wstep card-warm"/);
  const script = await read("src/balance-page.ts");
  assert.match(script, /renderLed\(/, "the balance is not drawn as an LED figure");
  assert.match(script, /setAttribute\("aria-busy", "true"\)/, "the tiles never show they are loading");
});

test("the wizard's progress is a labelled rail above the steps, with a draw meter and a funding gauge", async () => {
  const html = await read("fleet.html");
  const rail = html.indexOf('<ol class="dots" id="dots"');
  assert.ok(rail > 0 && rail < html.indexOf('data-wstep="welcome"'), "the rail sits below the steps");
  for (const label of ["Start", "Connect", "Size", "Backup", "Launch"]) assert.match(html, new RegExp(`<span>${label}</span>`));
  assert.match(html, /id="draw-meter" role="meter"/);
  assert.match(html, /id="funding-gauge"/);
  assert.doesNotMatch(html, /seam-card/, "the backup still uses the old seam card");
});

test("the wizard slides back when going back, and the rail's coral line extends rather than snapping", async () => {
  const css = await read("src/styles/pages.css");
  assert.match(css, /@keyframes step-back\s*\{[^}]*translateX\(-/, "going back slides the same way as going forward");
  assert.match(css, /#wizard\[data-dir="back"\] \.wstep:not\(\[hidden\]\)\s*\{\s*animation-name:\s*step-back/);
  assert.match(css, /\.dots li::after\s*\{\s*transition:\s*clip-path/, "the reached step's line snaps instead of extending");
  assert.doesNotMatch(css, /\.dots li\[data-done="true"\], \.dots li\[aria-current="step"\] \{[^}]*border-top-color/, "the rail still snaps its border to coral");
  const script = await read("src/fleet-page.ts");
  assert.match(script, /dataset\["dir"\] = /, "the wizard never says which way it is moving");
});

test("the Control Room asks before anything that cannot be undone", async () => {
  const script = await read("src/fleet-dashboard.ts");
  const control = /async #control\([\s\S]*?\n  \}/.exec(script);
  assert.ok(control, "no #control");
  assert.match(control[0], /confirmationFor\(action\)[\s\S]*?await confirmDialog\(/, "revoke and close run without asking");
  assert.ok(control[0].indexOf("confirmDialog(") < control[0].indexOf("signedFleetApi("), "it signs before asking");
  assert.match(script, /dataset\["live"\] = String\(isLiveState\(/, "the state chip never shows it is live");
  assert.match(script, /renderLed\(el\("draw-remaining"\)/, "the draw figures are not LED figures");
  assert.match(await read("fleet-dashboard.html"), /<section id="balance-strip" class="dash-card card-glass"/);
});

test("the Control Room pairs the draw's LED figures with a meter", async () => {
  const html = await read("fleet-dashboard.html");
  const start = html.indexOf('id="balance-strip"');
  const strip = html.slice(start, html.indexOf("</section>", start));
  assert.match(strip, /id="draw-used-meter" role="meter"/, "the draw figures have no meter");
  const script = await read("src/fleet-dashboard.ts");
  assert.match(script, /capShare\(this\.#draw\.remaining, this\.#draw\.amount\)/, "the meter is not filled from the draw");
});

test("a confirmation that fails to open still reaches the error banner", async () => {
  const script = await read("src/fleet-dashboard.ts");
  const control = /async #control\([\s\S]*?\n  \}/.exec(script);
  assert.ok(control, "no #control");
  assert.ok(control[0].indexOf("try {") >= 0 && control[0].indexOf("try {") < control[0].indexOf("confirmDialog("), "the dialog is awaited outside the try, so its failure is silent");
  const shared = await read("src/fleet/page-shared.ts");
  assert.match(shared, /dialog\.setAttribute\("aria-labelledby", heading\.id\)/, "the dialog's name duplicates its heading");
});

test("anything marked hidden stays hidden, whatever display a component sets", async () => {
  const components = await read("src/styles/components.css");
  assert.match(components, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/, "a component's display rule can un-hide a hidden element");
});

test("the top bar runs edge to edge and everything below it shares one column", async () => {
  const components = await read("src/styles/components.css");
  const shell = /\.fleet-shell\s*\{([^}]*)\}/.exec(components);
  assert.ok(shell, "no .fleet-shell rule");
  assert.doesNotMatch(shell[1]!, /max-width/, "the top bar is boxed in, so the wallet button sits short of the right edge");
  assert.match(components, /\.fleet-shell > main, \.fleet-shell > \.fleet-foot\s*\{[^}]*max-width:\s*var\(--column\)/, "the content and footer do not share one column");
  assert.match(components, /\.fleet-shell > \.pill\s*\{[^}]*margin-inline:\s*max\(0px, calc\(\(100% - var\(--column\)\) \/ 2\)\) auto/, "the pool pill does not line up with the column");
});

test("the welcome promises stack as one list, the way the page first had them", async () => {
  const components = await read("src/styles/components.css");
  const promises = /\.promises\s*\{([^}]*)\}/.exec(components);
  assert.ok(promises, "no .promises rule");
  assert.doesNotMatch(promises[1]!, /grid-template-columns/, "the promises are laid out as tiles again");
  assert.doesNotMatch(components, /\[data-wstep="welcome"\] \.primary \+ \.fineprint/, "the fine print sits beside the button instead of under it");
});

test("the Boundary page sets its four blocks as glass and solid cards", async () => {
  const html = await read("fleet-privacy.html");
  assert.doesNotMatch(html, /seam-card|seam-edge|seam-inner/, "the old seam motif is still here");
  assert.match(html, /<section class="card-glass boundary-block held"[^>]*>\s*<h2>Kept off the chain<\/h2>/);
  for (const id of ["public-facts", "private-fact", "privacy-claim", "pool-claim", "exclusions"]) assert.match(html, new RegExp(`id="${id}"`));
});

test("the old stylesheet is gone and every class the pages use is styled", async () => {
  const manifest = await read("fleet.css");
  assert.doesNotMatch(manifest, /@layer legacy\s*\{/, "the legacy layer still holds rules");
  const styled = (await Promise.all(NEW_STYLES.map(read))).join("\n");
  const used = new Set<string>(["wallet-chooser", "wallet-chooser-list", "wallet-chooser-status", "wallet-chooser-cancel", "confirm-dialog", "led", "led__dots", "led__unit", "reveal-ready"]);
  for (const page of PAGES) {
    for (const [, list] of (await read(page)).matchAll(/class="([^"]+)"/g)) for (const name of list!.split(/\s+/)) used.add(name);
  }
  const unstyled = [...used].filter((name) => !new RegExp(`\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(styled));
  assert.deepEqual(unstyled, [], "classes with no rule in the new layers");
});

test("text fits its box: mono labels, card-sized titles, figures as label-and-value rows", async () => {
  const [tokens, components] = await Promise.all([read("src/styles/tokens.css"), read("src/styles/components.css")]);
  assert.match(tokens, /--font-label:\s*var\(--font-mono\)/, "labels have no typeface of their own");
  assert.match(tokens, /--track-label:\s*0\.1\d+em/, "labels are not tracked out");
  const css = rules(components);
  for (const selector of [".kicker", ".cardlabel", ".summary dt"]) {
    const rule = css.find(([name]) => name.split(/,\s*/).includes(selector));
    assert.ok(rule && /font-family:\s*var\(--font-label\)/.test(rule[1]), `${selector} is not a mono label`);
  }
  const row = css.find(([name]) => name === ".summary div");
  assert.ok(row && /justify-content:\s*space-between/.test(row[1]), "figures sit in boxed tiles, not label-and-value rows");
  const cardTitle = css.find(([name]) => name.split(/,\s*/).includes(".wstep h2"));
  assert.ok(cardTitle && /font-size:\s*clamp\(1\.25rem/.test(cardTitle[1]), "card titles are sized for the page, not the card");
});

test("the pill never speaks from a stale read, and the Boundary page shows none", async () => {
  const pill = /export const initPoolStatus[\s\S]*?\n\};/.exec(await read("src/fleet/page-shared.ts"));
  assert.ok(pill && /freshPoolStatus\(/.test(pill[0]), "the pill reads the cache without asking how old it is");
  assert.match(await read("src/fleet-privacy.ts"), /initShell\(\{ pill: false \}\)/, "the Boundary page reads no balance, so it shows no pill");
});

test("nothing in the Control Room can push the page wider than the phone", async () => {
  const css = rules(await read("src/styles/pages.css"));
  const view = css.find(([name]) => name === "#fleet-view");
  assert.ok(view && /grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(view[1]), "one wide child widens the whole column");
  const accounts = css.find(([name]) => name === ".account-list li");
  assert.ok(accounts && /overflow-wrap:\s*anywhere/.test(accounts[1]) && !/text-overflow:\s*ellipsis/.test(accounts[1]), "addresses are clipped, and people compare their ends");
});

test("text on the warm cards is readable where the gradient is lightest", async () => {
  const [tokens, components] = await Promise.all([read("src/styles/tokens.css"), read("src/styles/components.css")]);
  const warm = rules(components).find(([name]) => name === ".card-warm");
  assert.ok(warm, "no .card-warm");
  assert.match(warm[1], /--text-muted:\s*var\(--paper\)/, "muted text on a warm card falls below 4.5:1");
  const stop = /linear-gradient\(160deg,\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(warm[1]);
  assert.ok(stop, "the warm gradient's light stop moved");
  const ground = cssColor(tokens, "--surface-bottom");
  const [r, g, b, a] = stop.slice(1).map(Number) as [number, number, number, number];
  const mix = (c: number, i: number): string =>
    Math.round(c * a + Number.parseInt(ground.slice(i, i + 2), 16) * (1 - a)).toString(16).padStart(2, "0");
  const lightest = `#${mix(r, 1)}${mix(g, 3)}${mix(b, 5)}`;
  const ratio = contrast(cssColor(tokens, "--paper"), lightest);
  assert.ok(ratio >= 4.5, `paper on the warm card's lightest stop is ${ratio.toFixed(2)}:1`);
});

test("the limits say only what the contract enforces", async () => {
  const html = await read("balance.html");
  assert.doesNotMatch(html, /Limits the pool contract enforces|The longest wait between activating/, "the contract has no 15-minute ceiling; only the service does");
  assert.match(html, /the contract enforces at least a minute/);
});

test("the phone menu takes focus in when it opens and gives it back when Escape closes it", async () => {
  const menu = /export const initMenu[\s\S]*?\n\};/.exec(await read("src/fleet/page-shared.ts"));
  assert.ok(menu, "no initMenu");
  assert.match(menu[0], /querySelector<HTMLElement>\("a"\)\?\.focus\(\)/, "opening the menu leaves focus behind it");
  assert.match(menu[0], /burger\.focus\(\)/, "Escape strands focus on a hidden link");
});

test("the funding wait shows on the screen the trader lands on after Launch", async () => {
  const done = /<section class="wstep" data-wstep="done"[\s\S]*?<\/section>/.exec(await read("fleet.html"));
  assert.ok(done, "no done step");
  assert.match(done[0], /id="funding-gauge"/);
  assert.match(done[0], /id="funding-wait"/);
});

test("actions follow Stow's pattern: pill buttons, the main action spans its card, stacked choices, no card inside a card", async () => {
  const css = rules(await read("src/styles/components.css"));
  const buttons = css.find(([name]) => name === ".primary, .ghost, .back, .linkbtn");
  assert.ok(buttons && /border-radius:\s*var\(--radius-pill\)/.test(buttons[1]), "buttons are square boxes, not pills");
  const big = css.find(([name]) => name === ".big");
  assert.ok(big && /width:\s*100%/.test(big[1]), "a card's main action does not span the card");
  const html = await read("fleet.html");
  assert.doesNotMatch(html, /class="card-glass backup-card"/, "the backup's two actions still sit in a card inside the step card");
  const pages = rules(await read("src/styles/pages.css"));
  const backup = pages.find(([name]) => name === ".backup-card");
  assert.ok(backup && /flex-direction:\s*column/.test(backup[1]) && /border-top:/.test(backup[1]), "the backup's actions are not a stacked section under a hairline");
});

test("a wide figure cannot push its rows past a phone's edge, and the exit card's actions stack", async () => {
  const components = rules(await read("src/styles/components.css"));
  const summary = components.find(([name]) => name === ".summary");
  assert.ok(summary && /grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(summary[1]), "the widest figure widens every row");
  const dots = components.find(([name]) => name === ".led__dots");
  assert.ok(dots && /max-width:\s*100%/.test(dots[1]), "an LED figure never shrinks to fit its box");
  const exit = rules(await read("src/styles/pages.css")).find(([name]) => name === "#exit-card .wnav");
  assert.ok(exit && /flex-direction:\s*column/.test(exit[1]), "the exit card's two actions squeeze into one row on a phone");
});

test("every action on the Control Room is a styled pill or row, never a bare button", async () => {
  const html = await read("fleet-dashboard.html");
  assert.match(html, /<button type="button" class="ghost" data-action="topUp">Top up<\/button>/, "Top up renders as an unstyled bar");
  const rows = rules(await read("src/styles/pages.css")).find(([name]) => name === ".control-list button");
  assert.ok(rows && /border-radius:\s*var\(--radius-inner\)/.test(rows[1]), "control rows keep square corners inside a rounded card");
});

test("the Trade page: fleet card, order form, orders list, and the honest line about public trades", async () => {
  const html = await read("trade.html");
  assert.match(html, /<main id="trade" class="dash">/);
  for (const id of ["fleet-switch", "fleet-chip", "fleet-left", "holdings", "order-form", "o-token", "o-quote", "o-total", "o-plan", "o-place", "orders-open", "orders-past", "trade-error"]) assert.match(html, new RegExp(`id="${id}"`), `no #${id}`);
  assert.match(html, /<button id="o-place" type="submit" class="primary big" disabled>Place order<\/button>/);
  assert.match(html, /Trades stay public/);
  assert.doesNotMatch(html, /organic|volume/i, "the stagger hides the funder, it does not sell volume");
  assert.match(await read("build.mjs"), /"trade-page": new URL\("\.\/src\/trade-page\.ts"/);
  assert.match(await read("build.mjs"), /"\.\/trade\.html"/);
});

test("the Trade page marks slices sent before it asks, never re-sends an unconfirmed one, and asks before it signs", async () => {
  const script = await read("src/trade-page.ts");
  const poll = /async #pollOnce\([\s\S]*?\n  \}/.exec(script);
  assert.ok(poll, "no #pollOnce");
  const send = poll[0].indexOf("orderTrade(wallet, current.orderToken");
  assert.ok(send > 0 && poll[0].indexOf("markSent(") < send, "the request leaves before the slices are marked sent");
  assert.match(poll[0], /markUnconfirmed\(/, "a lost reply leaves slices pending, so they would be re-sent");
  assert.match(script, /pending: pendingIndices\(/, "the service must receive only what the browser still holds");
  const place = /async #place\([\s\S]*?\n  \}/.exec(script);
  assert.ok(place && place[0].indexOf("confirmDialog(") < place[0].indexOf('signedFleetApi(wallet, "order"'), "placing an order does not confirm first");
  assert.match(await read("src/fleet/page-shared.ts"), /\["quote", "challenge", "read", "balance", "status", "tokenQuote", "order", "list", "holdings"\]/, "signed reads must not carry an idempotency key");
});

test("the Trade page's select and per-slice Copy buttons fit their rows", async () => {
  const pages = rules(await read("src/styles/pages.css"));
  const select = pages.find(([name]) => name.split(/,\s*/).includes(".field select"));
  assert.ok(select && /font-family:\s*var\(--font-mono\)/.test(select[1]), "the fleet switcher is the browser's default select");
  const label = pages.find(([name]) => name.split(/,\s*/).includes(".field > span"));
  assert.ok(label && /text-transform:\s*uppercase/.test(label[1]), "a field's span caption is not styled like its label");
  const copy = pages.find(([name]) => name === ".order__slices .ghost");
  assert.ok(copy && /min-height:\s*1\.\d+rem/.test(copy[1]), "per-slice Copy is a full-size pill and wraps the row");
});

test("polls never overlap, each sends from a fresh read, and lost replies reconcile from the unsigned status read", async () => {
  const script = await read("src/trade-page.ts");
  assert.match(script, /#polling/, "two polls can run at once and send the same slices twice");
  const once = /async #pollOnce\([\s\S]*?\n  \}/.exec(script);
  assert.ok(once, "no #pollOnce");
  assert.ok(once[0].indexOf("store.get(") < once[0].indexOf("markSent("), "a poll works from a stale snapshot instead of re-reading the order");
  assert.match(once[0], /readStatus\(/, "remainingAtSend is not a fresh read taken before the send");
  const reconcile = /async #reconcile\([\s\S]*?\n  \}/.exec(script);
  assert.ok(reconcile && /readStatus\(/.test(reconcile[0]) && !/signedFleetApi\(wallet, "list"/.test(reconcile[0]), "reconcile must not cost a wallet signature");
});

test("copying a slice's hash is announced, as copying the contract address is", async () => {
  assert.match(await read("trade.html"), /<span id="copy-status" class="sr-only" role="status" aria-live="polite"><\/span>/, "no live region for copy feedback");
  const row = /  #hashRow\(hash: string\)[\s\S]*?\n  \}/.exec(await read("src/trade-page.ts"));
  assert.ok(row && /copy-status/.test(row[0]), "the Copy button only changes its own text, which assistive tech may not announce");
});
