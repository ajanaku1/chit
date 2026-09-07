import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther, type Address, type Hex } from "viem";

import {
  DEPOSIT_SIZES,
  availableBalance,
  depositSizes,
  ledgerKey,
  openDepositor,
  sealDepositor,
} from "../../src/fleet/pool-ledger.js";

/**
 * The ledger is what makes the pool usable without a database: balances are
 * recomputed from chain state, and the depositor-to-campaign mapping travels
 * on chain as ciphertext only the operator can open.
 */
describe("Pool ledger", () => {
  const operatorKey = `0x${"7".repeat(64)}` as Hex;
  const key = ledgerKey(operatorKey);
  const alice = "0x00000000000000000000000000000000000a11ce" as Address;
  const bob = "0x00000000000000000000000000000000000b0b00" as Address;

  it("derives its key from the operator key and never equals it", () => {
    assert.notEqual(key.toLowerCase(), operatorKey.toLowerCase(), "domain separation, not the raw key");
    assert.equal(ledgerKey(operatorKey), key, "same operator key, same ledger key on any instance");
    assert.notEqual(ledgerKey(`0x${"8".repeat(64)}` as Hex), key);
  });

  it("seals and opens a depositor address, with a fresh nonce each time", () => {
    const first = sealDepositor(key, alice);
    const second = sealDepositor(key, alice);
    assert.notEqual(first, second, "equal ciphertexts would let anyone group a trader's campaigns");
    assert.equal(openDepositor(key, first)?.toLowerCase(), alice);
    assert.equal(openDepositor(key, second)?.toLowerCase(), alice);
  });

  it("refuses to open a ciphertext under the wrong key or after tampering", () => {
    const sealed = sealDepositor(key, alice);
    assert.equal(openDepositor(ledgerKey(`0x${"9".repeat(64)}` as Hex), sealed), undefined);
    const tampered = `${sealed.slice(0, -2)}${sealed.slice(-2) === "ff" ? "ee" : "ff"}` as Hex;
    assert.equal(openDepositor(key, tampered), undefined, "authentication, not just secrecy");
    assert.equal(openDepositor(key, "0x1234" as Hex), undefined);
  });

  it("counts deposits, posted spend, unposted queued spend, and open draws", () => {
    const inputs = {
      deposited: parseEther("0.1"),
      spent: parseEther("0.01"),
      queued: [
        { encDepositor: sealDepositor(key, alice), amount: parseEther("0.005"), posted: false },
        { encDepositor: sealDepositor(key, alice), amount: parseEther("0.004"), posted: true },
        { encDepositor: sealDepositor(key, bob), amount: parseEther("0.02"), posted: false },
      ],
      draws: [
        { ownerRef: sealDepositor(key, alice), amount: parseEther("0.02"), state: 1 as const },
        { ownerRef: sealDepositor(key, alice), amount: parseEther("0.01"), state: 3 as const },
        { ownerRef: sealDepositor(key, bob), amount: parseEther("0.03"), state: 2 as const },
      ],
    };
    // 0.1 − 0.01 posted − 0.005 queued unposted − 0.02 open draw = 0.065.
    assert.equal(availableBalance(key, alice, inputs), parseEther("0.065"));
    // A posted queued spend is already inside `spent`; counting it twice would
    // understate the balance and strand a trader's ETH.
    assert.notEqual(availableBalance(key, alice, inputs), parseEther("0.061"));
  });

  it("never returns a negative balance", () => {
    const available = availableBalance(key, alice, {
      deposited: parseEther("0.01"),
      spent: parseEther("0.02"),
      queued: [],
      draws: [],
    });
    assert.equal(available, 0n);
  });

  it("offers only the deposit sizes that both caps admit", () => {
    assert.deepEqual(depositSizes(parseEther("0.5"), parseEther("5")), [...DEPOSIT_SIZES]);
    assert.deepEqual(depositSizes(parseEther("0.04"), parseEther("5")), [parseEther("0.01")]);
    assert.deepEqual(depositSizes(parseEther("0.5"), parseEther("0.02")), [parseEther("0.01")]);
    assert.deepEqual(depositSizes(0n, parseEther("5")), [], "at the cap, nothing is offered");
  });
});
