import assert from "node:assert/strict";
import test from "node:test";

import type { Hex } from "viem";

import { forgetSignedReads, readSigned } from "../src/fleet/signed-read.js";

/**
 * A signed read is a wallet prompt. Switching tabs must not prompt again for
 * something this tab already read a moment ago.
 */

const WALLET = "0x00000000000000000000000000000000000000aa" as Hex;
const OTHER = "0x00000000000000000000000000000000000000bb" as Hex;

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
};

const counter = () => {
  const calls: string[] = [];
  const sign = async (wallet: Hex, action: string) => {
    calls.push(`${wallet}:${action}`);
    return { fleets: [{ campaign: `c${calls.length}` }] };
  };
  return { calls, sign };
};

test("a second read within the window signs nothing", async () => {
  const storage = memoryStorage();
  const { calls, sign } = counter();
  const now = new Date("2026-09-16T12:00:00Z");
  const first = await readSigned(WALLET, "list", {}, { storage, sign, now });
  const second = await readSigned(WALLET, "list", {}, { storage, sign, now: new Date(now.getTime() + 60_000) });
  assert.equal(calls.length, 1);
  assert.deepEqual(second, first);
});

test("an old answer, a forced read, another wallet, or another body each sign again", async () => {
  const storage = memoryStorage();
  const { calls, sign } = counter();
  const now = new Date("2026-09-16T12:00:00Z");
  await readSigned(WALLET, "list", {}, { storage, sign, now });
  await readSigned(WALLET, "list", {}, { storage, sign, now: new Date(now.getTime() + 11 * 60_000) });
  await readSigned(WALLET, "list", {}, { storage, sign, now, force: true });
  await readSigned(OTHER, "list", {}, { storage, sign, now });
  await readSigned(WALLET, "holdings", { campaign: "c1", tokens: ["0x01"] }, { storage, sign, now });
  await readSigned(WALLET, "holdings", { campaign: "c1", tokens: ["0x02"] }, { storage, sign, now });
  assert.equal(calls.length, 6);
});

test("forgetting a wallet's reads makes the next one live, and leaves other wallets cached", async () => {
  const storage = memoryStorage();
  const { calls, sign } = counter();
  const now = new Date("2026-09-16T12:00:00Z");
  await readSigned(WALLET, "list", {}, { storage, sign, now });
  await readSigned(OTHER, "list", {}, { storage, sign, now });
  forgetSignedReads(WALLET, storage);
  await readSigned(WALLET, "list", {}, { storage, sign, now });
  await readSigned(OTHER, "list", {}, { storage, sign, now });
  assert.deepEqual(calls, [`${WALLET}:list`, `${OTHER}:list`, `${WALLET}:list`]);
});

test("two reads while the first prompt is open share one prompt", async () => {
  const storage = memoryStorage();
  const { calls, sign } = counter();
  const [a, b] = await Promise.all([
    readSigned(WALLET, "list", {}, { storage, sign }),
    readSigned(WALLET, "list", {}, { storage, sign }),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
});

test("a refused or failed read is not kept", async () => {
  const storage = memoryStorage();
  let calls = 0;
  const sign = async () => {
    calls += 1;
    if (calls === 1) throw new Error("user rejected");
    return { fleets: [] };
  };
  await assert.rejects(readSigned(WALLET, "list", {}, { storage, sign }));
  assert.deepEqual(await readSigned(WALLET, "list", {}, { storage, sign }), { fleets: [] });
  assert.equal(calls, 2);
});
