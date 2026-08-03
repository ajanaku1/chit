import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PREVIOUS_SPONSOR,
  admissionIsUsable,
  nextActiveSponsorAction,
  parseActiveSponsorTarget,
  parseSponsorCheckpoint,
} from "../src/active-sponsor.js";

const digest = `0x${"ab".repeat(32)}` as const;
const signature = `0x${"cd".repeat(65)}` as const;
const transaction = `0x${"ef".repeat(32)}` as const;

const round = {
  chainId: 11_155_111,
  creator: "0x34b0Ba20669f3ec4F1056853780c381e5e35F724",
  wrapper: "0xF2A752BACb7faB05117bA8040F4f55537D50A60c",
  factory: "0xae9f63B7E7b0aC875AaDBEC56efCccFb88Ea87e6",
  roundId: `0x${"12".repeat(32)}`,
  vault: "0x207037E290572Bd8839365203182aA5f0F9FdDAD",
};

const assets = {
  chainId: 11_155_111,
  chitToken: "0x19c151c602484234b689c46f3d2481dc05a7bfdb",
  chitBudgetToken: "0xf2a752bacb7fab05117ba8040f4f55537d50a60c",
};

describe("active sponsor target", () => {
  it("pins the previous sponsor to the new low-stake vault", () => {
    const target = parseActiveSponsorTarget(round, assets);

    assert.equal(target.sponsor, PREVIOUS_SPONSOR);
    assert.equal(target.vault, round.vault);
    assert.equal(target.chitToken.toLowerCase(), assets.chitToken);
    assert.equal(target.chitBudgetToken, round.wrapper);
  });

  it("uses an explicitly configured sponsor for a creator-owned round", () => {
    const target = parseActiveSponsorTarget({
      ...round,
      sponsor: round.creator,
    }, assets);

    assert.equal(target.sponsor, round.creator);
  });

  it("rejects assets from a different wrapper or chain", () => {
    assert.throws(
      () => parseActiveSponsorTarget(round, { ...assets, chainId: 1 }),
      /Sepolia|chain/i,
    );
    assert.throws(
      () =>
        parseActiveSponsorTarget(round, {
          ...assets,
          chitBudgetToken: "0x0000000000000000000000000000000000000001",
        }),
      /wrapper/i,
    );
  });
});

describe("sponsor recovery checkpoint", () => {
  it("accepts only a complete creator admission and public transaction hashes", () => {
    const checkpoint = parseSponsorCheckpoint({
      admissionExpiry: 2_000_000_000,
      admissionDigest: digest,
      admissionSignature: signature,
      wrapTx: transaction,
      pendingHash: transaction,
      pendingLabel: "wrap",
    });

    assert.equal(checkpoint.admissionDigest, digest);
    assert.equal(checkpoint.wrapTx, transaction);
  });

  it("rejects partial or malformed creator admissions", () => {
    assert.throws(
      () => parseSponsorCheckpoint({ admissionSignature: signature }),
      /admission.*complete/i,
    );
    assert.throws(
      () =>
        parseSponsorCheckpoint({
          admissionExpiry: 2_000_000_000,
          admissionDigest: digest,
          admissionSignature: "0x1234",
        }),
      /signature/i,
    );
  });

  it("rejects incomplete or unknown pending transaction checkpoints", () => {
    assert.throws(
      () => parseSponsorCheckpoint({ pendingHash: transaction }),
      /pending.*complete/i,
    );
    assert.throws(
      () => parseSponsorCheckpoint({ pendingHash: transaction, pendingLabel: "mint" }),
      /pendingLabel/i,
    );
  });

  it("requires the saved admission to match the live digest and remain fresh", () => {
    const checkpoint = parseSponsorCheckpoint({
      admissionExpiry: 2_000,
      admissionDigest: digest,
      admissionSignature: signature,
    });

    assert.equal(admissionIsUsable(checkpoint, digest, 1_000), true);
    assert.equal(admissionIsUsable(checkpoint, digest, 1_900), false);
    assert.equal(
      admissionIsUsable(checkpoint, `0x${"01".repeat(32)}`, 1_000),
      false,
    );
  });
});

describe("active sponsor action order", () => {
  const ready = {
    pending: false,
    admission: true,
    sponsorWallet: true,
    allowance: true,
    wrapped: true,
    operator: true,
    registered: true,
  };

  it("pauses for a creator admission before switching to the sponsor", () => {
    assert.deepEqual(
      nextActiveSponsorAction({ ...ready, admission: false, registered: false }),
      { kind: "sign-admission" },
    );
    assert.deepEqual(
      nextActiveSponsorAction({ ...ready, sponsorWallet: false, registered: false }),
      { kind: "switch-sponsor" },
    );
  });

  it("orders allowance, wrap, operator, and registration without skipping", () => {
    assert.deepEqual(
      nextActiveSponsorAction({ ...ready, allowance: false, wrapped: false, operator: false, registered: false }),
      { kind: "approve-token" },
    );
    assert.deepEqual(
      nextActiveSponsorAction({ ...ready, wrapped: false, operator: false, registered: false }),
      { kind: "wrap-token" },
    );
    assert.deepEqual(
      nextActiveSponsorAction({ ...ready, operator: false, registered: false }),
      { kind: "authorize-vault" },
    );
    assert.deepEqual(
      nextActiveSponsorAction({ ...ready, registered: false }),
      { kind: "register-sponsor" },
    );
    assert.deepEqual(nextActiveSponsorAction(ready), { kind: "complete" });
  });

  it("reconciles an in-flight transaction first", () => {
    assert.deepEqual(
      nextActiveSponsorAction({ ...ready, pending: true, registered: false }),
      { kind: "reconcile-pending" },
    );
  });
});
