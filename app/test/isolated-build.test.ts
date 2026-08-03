import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const appRoot = join(projectRoot, "app");

async function copyBuildInputs(workspace: string): Promise<void> {
  await mkdir(join(workspace, "app"), { recursive: true });
  await Promise.all([
    cp(join(appRoot, "build.mjs"), join(workspace, "app", "build.mjs")),
    cp(join(appRoot, "index.html"), join(workspace, "app", "index.html")),
    cp(join(appRoot, "style.css"), join(workspace, "app", "style.css")),
    cp(join(appRoot, "sponsor.html"), join(workspace, "app", "sponsor.html")),
    cp(join(appRoot, "sponsor.css"), join(workspace, "app", "sponsor.css")),
    cp(join(appRoot, "creator-round.json"), join(workspace, "app", "creator-round.json")),
    cp(join(appRoot, "assets.json"), join(workspace, "app", "assets.json")),
    cp(join(appRoot, "rotate.html"), join(workspace, "app", "rotate.html")),
    cp(join(appRoot, "enroll.html"), join(workspace, "app", "enroll.html")),
    cp(join(appRoot, "sponsor-two.html"), join(workspace, "app", "sponsor-two.html")),
    cp(join(appRoot, "user-operation.html"), join(workspace, "app", "user-operation.html")),
    cp(join(appRoot, "service-target.json"), join(workspace, "app", "service-target.json")),
    cp(join(appRoot, "src"), join(workspace, "app", "src"), { recursive: true }),
    cp(join(projectRoot, "spikes", "active-sponsor", "main.ts"), join(workspace, "spikes", "active-sponsor", "main.ts")),
    cp(join(projectRoot, "spikes", "service-rotation", "main.ts"), join(workspace, "spikes", "service-rotation", "main.ts")),
    cp(join(projectRoot, "spikes", "enrollment", "main.ts"), join(workspace, "spikes", "enrollment", "main.ts")),
    cp(join(projectRoot, "spikes", "operator-sponsor", "main.ts"), join(workspace, "spikes", "operator-sponsor", "main.ts")),
    cp(join(projectRoot, "spikes", "hosted-user-operation", "main.ts"), join(workspace, "spikes", "hosted-user-operation", "main.ts")),
    cp(join(projectRoot, "src"), join(workspace, "src"), { recursive: true }),
    cp(join(projectRoot, "brand"), join(workspace, "brand"), { recursive: true }),
  ]);
  await symlink(
    join(projectRoot, "node_modules"),
    join(workspace, "app", "node_modules"),
    "dir",
  );
}

test("builds when dependencies exist only under app/node_modules", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chit-app-build-"));
  try {
    await copyBuildInputs(workspace);
    await execute(process.execPath, [join(workspace, "app", "build.mjs")]);
    const bundle = await readFile(join(workspace, "app", "dist", "main.js"), "utf8");
    assert.ok(bundle.length > 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
