import { build } from "esbuild";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
// A URL's pathname is not a file path on Windows ("/D:/…"), and a Windows path
// is not a URL; esbuild is given paths, so both crossings go through node:url.
import { fileURLToPath, pathToFileURL } from "node:url";

import { chainTargetFromEnv, sessionTargetFromEnv, withBetaNote, withCaps } from "./chain-target.mjs";

// APP_OUTPUT: explicit output directory (scripts/assemble-site.mjs sets it to
// public/app/ so the app deploys beneath the landing). Default: ./dist.
const output = process.env.APP_OUTPUT
  ? pathToFileURL(`${process.env.APP_OUTPUT.replace(/[\/]?$/, "/")}`)
  : new URL("./dist/", import.meta.url);

// The chain, from the environment, at build time (T054): chain-target.json is
// written here, never copied, and the beta note goes into every page (T056).
const target = chainTargetFromEnv(process.env);
const page = async (source) => writeFile(new URL(source.replace(/^\.\//, ""), output), withCaps(withBetaNote(await readFile(new URL(source, import.meta.url), "utf8"), target), target));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(new URL("styles/", output), { recursive: true });
// The typefaces ship with the app (tokens.css reads them from ../fonts), so no page loads a third-party asset.
await mkdir(new URL("fonts/", output), { recursive: true });
const fonts = (await readdir(new URL("./src/fonts/", import.meta.url))).filter((name) => name.endsWith(".woff2"));
await Promise.all(fonts.map((name) => copyFile(new URL(`./src/fonts/${name}`, import.meta.url), new URL(`fonts/${name}`, output))));
await writeFile(new URL("chain-target.json", output), `${JSON.stringify(target, null, 2)}\n`);
await Promise.all([
  page("./fleet.html"),
  copyFile(new URL("./fleet.css", import.meta.url), new URL("fleet.css", output)),
  copyFile(new URL("./src/styles/tokens.css", import.meta.url), new URL("styles/tokens.css", output)),
  copyFile(new URL("./src/styles/components.css", import.meta.url), new URL("styles/components.css", output)),
  copyFile(new URL("./src/styles/pages.css", import.meta.url), new URL("styles/pages.css", output)),
  page("./fleet-dashboard.html"),
  page("./fleet-privacy.html"),
  page("./balance.html"),
  page("./trade.html"),
  page("./sessions.html"),
  page("./control.html"),
  // Written, never copied: a factory belongs to the chain it was deployed on, and a build must not ship the other host's (T081).
  writeFile(new URL("session-target.json", output), `${JSON.stringify(sessionTargetFromEnv(process.env), null, 2)}
`),
  copyFile(new URL("../brand/logo.svg", import.meta.url), new URL("logo.svg", output)),
  copyFile(new URL("../brand/favicon.svg", import.meta.url), new URL("favicon.svg", output)),
]);
await build({
  entryPoints: {
    "fleet-page": fileURLToPath(new URL("./src/fleet-page.ts", import.meta.url)),
    "fleet-dashboard": fileURLToPath(new URL("./src/fleet-dashboard.ts", import.meta.url)),
    "fleet-privacy": fileURLToPath(new URL("./src/fleet-privacy.ts", import.meta.url)),
    "balance-page": fileURLToPath(new URL("./src/balance-page.ts", import.meta.url)),
    "trade-page": fileURLToPath(new URL("./src/trade-page.ts", import.meta.url)),
    "sessions-page": fileURLToPath(new URL("./src/sessions-page.ts", import.meta.url)),
    "control-page": fileURLToPath(new URL("./src/control-page.ts", import.meta.url)),
  },
  outdir: fileURLToPath(output),
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: true,
  target: "es2022",
  nodePaths: [fileURLToPath(new URL("./node_modules", import.meta.url))],
  // The bundle's own default chain is this build's, not a constant: a page
  // that cannot read chain-target.json still belongs to its host (T081).
  define: { __CHAIN_TARGET__: JSON.stringify({ chainId: target.chainId, chainName: target.chainName, rpcUrls: target.rpcUrls }) },
});
