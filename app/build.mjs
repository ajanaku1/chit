import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { chainTargetFromEnv, withBetaNote, withCaps } from "./chain-target.mjs";

// APP_OUTPUT: explicit output directory (scripts/assemble-site.mjs sets it to
// public/app/ so the app deploys beneath the landing). Default: ./dist.
const output = process.env.APP_OUTPUT
  ? new URL(`file://${process.env.APP_OUTPUT}`)
  : new URL("./dist/", import.meta.url);

// The chain, from the environment, at build time (T054): chain-target.json is
// written here, never copied, and the beta note goes into every page (T056).
const target = chainTargetFromEnv(process.env);
const page = async (source) => writeFile(new URL(source.replace(/^\.\//, ""), output), withCaps(withBetaNote(await readFile(new URL(source, import.meta.url), "utf8"), target), target));

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(new URL("styles/", output), { recursive: true });
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
  copyFile(new URL("./session-target.json", import.meta.url), new URL("session-target.json", output)),
  copyFile(new URL("../brand/logo.svg", import.meta.url), new URL("logo.svg", output)),
  copyFile(new URL("../brand/favicon.svg", import.meta.url), new URL("favicon.svg", output)),
]);
await build({
  entryPoints: {
    "fleet-page": new URL("./src/fleet-page.ts", import.meta.url).pathname,
    "fleet-dashboard": new URL("./src/fleet-dashboard.ts", import.meta.url).pathname,
    "fleet-privacy": new URL("./src/fleet-privacy.ts", import.meta.url).pathname,
    "balance-page": new URL("./src/balance-page.ts", import.meta.url).pathname,
    "trade-page": new URL("./src/trade-page.ts", import.meta.url).pathname,
    "sessions-page": new URL("./src/sessions-page.ts", import.meta.url).pathname,
  },
  outdir: output.pathname,
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: true,
  target: "es2022",
  nodePaths: [new URL("./node_modules", import.meta.url).pathname],
});
