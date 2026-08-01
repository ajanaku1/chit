import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SEPOLIA_CHAIN_ID,
  assertAdmissionFresh,
  assertGateSponsor,
  assertNoxProof,
  assertSepolia,
  classifyWalletAccount,
  connectedWalletAddress,
  parseFactoryGateEvidence,
  proofByteLength,
  selectLegacyRabbyProvider,
  selectRabbyProvider,
} from "../src/browser-nox.js";

const factoryGateEvidence = {
  chainId: SEPOLIA_CHAIN_ID,
  sponsor: "0x536ad0665e4041e7e1843e0ce01b72ff90a9a4e5",
  chitToken: "0x19c151c602484234b689c46f3d2481dc05a7bfdb",
  chitBudgetToken: "0xf2a752bacb7fab05117ba8040f4f55537d50a60c",
  vault: "0xa43dd18306082b24418d7c04a3e2d755ae4b0a9a",
  admissionExpiry: 2_000_000_000,
  admissionSignature: `0x${"ab".repeat(65)}`,
};

describe("browser Nox gate helpers", () => {
  it("distinguishes a matching creator from another authorized account", () => {
    const creator = "0x34b0ba20669f3ec4f1056853780c381e5e35f724";
    const sameCreator = `0x${creator.slice(2).toUpperCase()}`;
    const other = "0xd39229508da2126d0e1b4f68bb14e1b48810134b";

    assert.deepEqual(classifyWalletAccount([], creator), { kind: "none" });
    assert.deepEqual(classifyWalletAccount([sameCreator], creator), {
      kind: "match",
      account: sameCreator,
    });
    assert.deepEqual(classifyWalletAccount([other], creator), {
      kind: "mismatch",
      account: other,
      expected: creator,
    });
  });

  it("reuses an already connected injected-wallet account", () => {
    const account = "0x34b0ba20669f3ec4f1056853780c381e5e35f724";

    assert.equal(connectedWalletAddress([account]), account);
    assert.equal(connectedWalletAddress([]), undefined);
    assert.equal(connectedWalletAddress(["not-an-address"]), undefined);
    assert.equal(connectedWalletAddress("not-an-array"), undefined);
  });

  it("accepts only Ethereum Sepolia", () => {
    assert.doesNotThrow(() => assertSepolia(SEPOLIA_CHAIN_ID));
    assert.throws(() => assertSepolia(1), /Sepolia/);
  });

  it("measures the required 137-byte proof", () => {
    const proof = `0x${"ab".repeat(137)}`;

    assert.equal(proofByteLength(proof), 137);
  });

  it("rejects malformed proof hex", () => {
    assert.throws(() => proofByteLength("0xabc"), /hex/);
    assert.throws(() => proofByteLength("proof"), /hex/);
  });

  it("requires the live gateway's 137-byte proof", () => {
    assert.doesNotThrow(() => assertNoxProof(`0x${"ab".repeat(137)}`));
    assert.throws(() => assertNoxProof(`0x${"ab".repeat(136)}`), /137/);
  });

  it("selects Rabby from multiple injected wallet providers", () => {
    const brave = { id: "brave" };
    const rabby = { id: "rabby" };
    const providers = [
      { info: { name: "Brave Wallet", rdns: "com.brave.wallet" }, provider: brave },
      { info: { name: "Rabby Wallet", rdns: "io.rabby" }, provider: rabby },
    ];

    assert.equal(selectRabbyProvider(providers), rabby);
  });

  it("fails clearly when Rabby is not injected", () => {
    const providers = [
      { info: { name: "Brave Wallet", rdns: "com.brave.wallet" }, provider: {} },
    ];

    assert.throws(() => selectRabbyProvider(providers), /Rabby/);
  });

  it("selects Rabby from Brave's legacy provider array", () => {
    const brave = { isBraveWallet: true };
    const rabby = { isRabby: true };

    assert.equal(selectLegacyRabbyProvider([brave, rabby]), rabby);
    assert.throws(() => selectLegacyRabbyProvider([brave]), /Rabby/);
  });

  it("parses a complete factory browser-gate record", () => {
    const parsed = parseFactoryGateEvidence(factoryGateEvidence);

    assert.equal(parsed.vault, factoryGateEvidence.vault);
    assert.equal(parsed.admissionExpiry, factoryGateEvidence.admissionExpiry);
  });

  it("rejects a deployment record for another chain", () => {
    assert.throws(
      () => parseFactoryGateEvidence({ ...factoryGateEvidence, chainId: 1 }),
      /Sepolia/,
    );
  });

  it("binds the connected wallet to the admitted sponsor", () => {
    assert.doesNotThrow(() =>
      assertGateSponsor(factoryGateEvidence.sponsor, factoryGateEvidence.sponsor.toUpperCase()),
    );
    assert.throws(
      () =>
        assertGateSponsor(
          factoryGateEvidence.sponsor,
          "0x34b0ba20669f3ec4f1056853780c381e5e35f724",
        ),
      /admitted sponsor/,
    );
  });

  it("requires enough admission lifetime to finish wallet approvals", () => {
    assert.doesNotThrow(() => assertAdmissionFresh(2_000, 1_000));
    assert.throws(() => assertAdmissionFresh(1_050, 1_000), /expired|fresh/i);
  });
});
