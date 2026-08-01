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
    cp(join(appRoot, "src"), join(workspace, "app", "src"), { recursive: true }),
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
