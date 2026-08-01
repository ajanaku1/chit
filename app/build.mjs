import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

const output = new URL("./dist/", import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  copyFile(new URL("./index.html", import.meta.url), new URL("index.html", output)),
  copyFile(new URL("./style.css", import.meta.url), new URL("style.css", output)),
  copyFile(new URL("../brand/logo.svg", import.meta.url), new URL("logo.svg", output)),
  copyFile(new URL("../brand/favicon.svg", import.meta.url), new URL("favicon.svg", output)),
]);
await build({
  entryPoints: [new URL("./src/main.ts", import.meta.url).pathname],
  outfile: new URL("main.js", output).pathname,
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: true,
  target: "es2022",
  nodePaths: [new URL("./node_modules", import.meta.url).pathname],
});
