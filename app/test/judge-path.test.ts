import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("publishes a no-wallet judge path for the verified lifecycle", async () => {
  const html = await readFile(join(appRoot, "index.html"), "utf8");

  assert.match(html, /id="judge-path"/);
  assert.match(html, /Open proven UserOperation/);
  assert.match(html, /Open encrypted settlement/);
  assert.match(html, /0\.111 Sepolia ETH/);
  assert.match(
    html,
    /https:\/\/eth-sepolia\.blockscout\.com\/tx\/0x0e5ddf0b032f284399cfe2ae3fbe8cf664ebc4c0a0e0acbdd56611d512f35970/,
  );
  assert.match(
    html,
    /https:\/\/eth-sepolia\.blockscout\.com\/tx\/0x99cd61e2ff3d6bdbca4bcb492a68a3d3891f7b9d42dea2242a8b2219a7e3996f/,
  );
});
