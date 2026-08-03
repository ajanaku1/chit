import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

const output = process.env.VERCEL === "1"
  ? new URL("../public/", import.meta.url)
  : new URL("./dist/", import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  copyFile(new URL("./index.html", import.meta.url), new URL("index.html", output)),
  copyFile(new URL("./style.css", import.meta.url), new URL("style.css", output)),
  copyFile(new URL("./sponsor.html", import.meta.url), new URL("sponsor.html", output)),
  copyFile(new URL("./sponsor.css", import.meta.url), new URL("sponsor.css", output)),
  copyFile(new URL("./creator-round.json", import.meta.url), new URL("creator-round.json", output)),
  copyFile(new URL("./assets.json", import.meta.url), new URL("assets.json", output)),
  copyFile(new URL("./rotate.html", import.meta.url), new URL("rotate.html", output)),
  copyFile(new URL("./enroll.html", import.meta.url), new URL("enroll.html", output)),
  copyFile(new URL("./sponsor-two.html", import.meta.url), new URL("sponsor-two.html", output)),
  copyFile(new URL("./user-operation.html", import.meta.url), new URL("user-operation.html", output)),
  copyFile(new URL("./service-target.json", import.meta.url), new URL("service-target.json", output)),
  copyFile(new URL("../brand/logo.svg", import.meta.url), new URL("logo.svg", output)),
  copyFile(new URL("../brand/favicon.svg", import.meta.url), new URL("favicon.svg", output)),
]);
await build({
  entryPoints: {
    main: new URL("./src/main.ts", import.meta.url).pathname,
    sponsor: new URL("../spikes/active-sponsor/main.ts", import.meta.url).pathname,
    rotate: new URL("../spikes/service-rotation/main.ts", import.meta.url).pathname,
    enroll: new URL("../spikes/enrollment/main.ts", import.meta.url).pathname,
    "sponsor-two": new URL("../spikes/operator-sponsor/main.ts", import.meta.url).pathname,
    "user-operation": new URL("../spikes/hosted-user-operation/main.ts", import.meta.url).pathname,
  },
  outdir: output.pathname,
  bundle: true,
  format: "esm",
  minify: true,
  sourcemap: true,
  target: "es2022",
  nodePaths: [new URL("./node_modules", import.meta.url).pathname],
});
