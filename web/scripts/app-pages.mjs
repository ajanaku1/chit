// Turns the app pages (../app/*.html) into React components for this project, once, so the pages keep
// every id, class and attribute the app's logic (chit-fleet/app/src) looks up. Run it again after
// a page's markup changes there: node scripts/app-pages.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";

const SRC = new URL("../../app/", import.meta.url);
const OUT = new URL("../components/app-pages/", import.meta.url);

const PAGES = {
  balance: "BalanceMarkup",
  fleet: "FleetMarkup",
  "fleet-dashboard": "DashboardMarkup",
  "fleet-privacy": "PrivacyMarkup",
  trade: "TradeMarkup",
  sessions: "SessionsMarkup",
};

const RENAME = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", inputmode: "inputMode", autocomplete: "autoComplete",
  readonly: "readOnly", maxlength: "maxLength", minlength: "minLength", spellcheck: "spellCheck", autofocus: "autoFocus",
  novalidate: "noValidate", colspan: "colSpan", rowspan: "rowSpan", datetime: "dateTime", enterkeyhint: "enterKeyHint",
  crossorigin: "crossOrigin", "stroke-width": "strokeWidth", "stroke-linecap": "strokeLinecap", "stroke-linejoin": "strokeLinejoin",
  "fill-rule": "fillRule", "clip-rule": "clipRule", "stop-color": "stopColor", "stop-opacity": "stopOpacity", "text-anchor": "textAnchor",
  "dominant-baseline": "dominantBaseline", "font-size": "fontSize", "font-family": "fontFamily", "stroke-dasharray": "strokeDasharray",
};
const NUMERIC = new Set(["aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-level", "aria-setsize", "aria-posinset", "aria-colcount", "aria-rowcount", "tabIndex", "maxLength", "minLength", "colSpan", "rowSpan"]);
const VOID = new Set(["input", "img", "br", "hr", "meta", "link", "source", "col", "wbr"]);

const styleObject = (css) => {
  const pairs = css.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(":");
    const k = d.slice(0, i).trim();
    const v = d.slice(i + 1).trim();
    const key = k.startsWith("--") ? JSON.stringify(k) : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return `${key}: ${JSON.stringify(v)}`;
  });
  return `{{ ${pairs.join(", ")} }}`;
};

const convertTag = (tag) => {
  const m = /^<([a-zA-Z][\w-]*)([\s\S]*?)(\/?)>$/.exec(tag);
  if (!m) return tag;
  const [, name, rawAttrs, selfClose] = m;
  const attrs = [];
  const re = /([^\s=/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
  let a;
  let isInput = name === "input" || name === "textarea";
  while ((a = re.exec(rawAttrs))) {
    let key = a[1];
    const value = a[3] ?? a[4];
    const lower = key.toLowerCase();
    if (lower === "style" && value !== undefined) { attrs.push(`style=${styleObject(value)}`); continue; }
    key = RENAME[lower] ?? key;
    // A value written in the markup is where the field starts, not a value React should hold it to.
    if (isInput && key === "value") key = "defaultValue";
    if (isInput && key === "checked") key = "defaultChecked";
    if (value === undefined) attrs.push(key);
    else if (NUMERIC.has(key) && /^-?\d+(\.\d+)?$/.test(value)) attrs.push(`${key}={${value}}`);
    else attrs.push(`${key}=${JSON.stringify(value).replace(/\\\\/g, "\\")}`);
  }
  const close = VOID.has(name.toLowerCase()) || selfClose ? " /" : "";
  return `<${name}${attrs.length ? " " + attrs.join(" ") : ""}${close}>`;
};

// React picks a select's starting option from the select, not from a `selected` option.
const selects = (html) =>
  html.replace(/<select([^>]*)>([\s\S]*?)<\/select>/g, (_, attrs, options) => {
    const chosen = /<option value="([^"]*)" selected>/.exec(options);
    if (!chosen) return `<select${attrs}>${options}</select>`;
    return `<select${attrs} defaultValue="${chosen[1]}">${options.replace(/ selected>/, ">")}</select>`;
  });

const toJsx = (html) =>
  selects(html)
    .replace(/<!--([\s\S]*?)-->/g, (_, c) => `{/*${c.replace(/\*\//g, "* /")}*/}`)
    .replace(/<[a-zA-Z][^<>]*>/g, convertTag)
    // Text braces would read as expressions.
    .replace(/>([^<]*)</g, (_, text) => {
      const escaped = text.replace(/[{}]/g, (b) => `{"${b}"}`);
      if (!escaped.trim()) return `>${escaped}<`;
      // JSX drops a line break beside a tag; HTML reads it as a space between the words and the link.
      return `>${escaped.replace(/^\s*\n\s*/, '{" "}\n').replace(/\s*\n\s*$/, '\n{" "}')}<`;
    })
    // ...but not the comments just made.
    .replace(/\{"\{"\}\/\*/g, "{/*").replace(/\*\/\{"\}"\}/g, "*/}");

/**
 * What app/build.mjs writes into a page for its chain (withBetaNote, withCaps), written here as
 * expressions of components/chain.tsx, so the prerendered HTML already carries it: the statement
 * beside the deposit amount and the gate's sentence on the beta, and the chain's own draw cap.
 */
const forChain = (jsx) =>
  jsx
    .replace(/<(\w+)([^>]*?) data-beta-note([^>]*?) hidden([^>]*)><\/\1>/g, (_, tag, a, b, c) => `<${tag}${a} data-beta-note${b} hidden={!BETA}${c}>{BETA ? BETA_NOTE : null}</${tag}>`)
    .replace(/<(\w+)([^>]*?) data-beta-gate-note([^>]*?) hidden([^>]*)><\/\1>/g, (_, tag, a, b, c) => `<${tag}${a} data-beta-gate-note${b} hidden={!BETA}${c}>{BETA ? GATE_SENTENCE : null}</${tag}>`)
    .replace(/data-led="[0-9.]+" data-unit="ETH" data-cap="draw">[0-9.]+ ETH/g, 'data-led={DRAW_CAP} data-unit="ETH" data-cap="draw">{`${DRAW_CAP} ETH`}')
    .replace(/aria-label="This draw against the [0-9.]+ ETH cap"/g, "aria-label={`This draw against the ${DRAW_CAP} ETH cap`}");

await mkdir(OUT, { recursive: true });
for (const [page, component] of Object.entries(PAGES)) {
  const html = await readFile(new URL(`${page}.html`, SRC), "utf8");
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "Chit";
  const description = /name="description"\s+content="([^"]*)"/.exec(html)?.[1] ?? "";
  const skip = /<a class="skip-link" href="#([^"]+)">([^<]+)<\/a>/.exec(html);
  const afterHeader = html.slice(html.indexOf("</header>") + "</header>".length, html.lastIndexOf("<script"));
  const inner = afterHeader.slice(0, afterHeader.lastIndexOf("</div>"));
  const body = forChain(toJsx(inner)).split("\n").map((l) => l.replace(/^ {6}/, "      ")).join("\n");
  const used = ["BETA", "BETA_NOTE", "GATE_SENTENCE", "DRAW_CAP"].filter((name) => new RegExp(`\\b${name}\\b`).test(body));
  const tsx = `// Drawn from chit-fleet/app/${page}.html by scripts/app-pages.mjs; every id and class is the one the app's logic reads.
/* eslint-disable */
${used.length ? `import { ${used.join(", ")} } from "@/components/chain";\n\n` : ""}export const meta = { title: ${JSON.stringify(title)}, description: ${JSON.stringify(description)}, skip: ${JSON.stringify(skip ? { href: `#${skip[1]}`, label: skip[2] } : null)} };

export function ${component}() {
  return (
    <>
${body}
    </>
  );
}
`;
  await writeFile(new URL(`${page}.tsx`, OUT), tsx);
  console.log(page, "→", component);
}
