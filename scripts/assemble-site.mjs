// Assembles the chit.tools deploy: the landing at the root and the Fleet app
// under /app, with the API functions served from api/ by Vercel. Output: public/.
import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const output = new URL("public/", root);

// The progress sheet's numbers come from the task lists being deployed, not from a file a robot pushed.
const progress = spawnSync(process.execPath, ["scripts/progress.mjs"], { cwd: root, stdio: "inherit" });
if (progress.status !== 0) process.exit(progress.status ?? 1);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL("landing/public/", root), output, { recursive: true });

const app = spawnSync("npm", ["--prefix", "app", "run", "build"], {
  cwd: root, stdio: "inherit", env: { ...process.env, APP_OUTPUT: new URL("app/", output).pathname },
});
if (app.status !== 0) process.exit(app.status ?? 1);
