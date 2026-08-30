/**
 * Browser-layer acceptance (FR-001 to FR-017, SC-001, SC-010).
 *
 * The three browser modules working together as one journey: real Vault v1
 * cryptography inside the setup flow, the boundary guarding every outgoing
 * payload, and the Control Room views on the far side.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CampaignSetup, type SetupDeps, type GeneratedAccount } from "../src/fleet/campaign-setup.js";
import { buildBuyReport, buildControlRoomView } from "../src/fleet/control-room.js";
import { FLEET_PRIVACY_CLAIM } from "../src/fleet/index.js";
import { confirmRecovery, createRecoveryVault, type VaultContext } from "../src/fleet/vault.js";

const primary = privateKeyToAccount(`0x${"11".repeat(32)}`);

test("the full browser journey: connect, configure, vault, create, fund, activate", async () => {
  const submitted: { action: string; body: Record<string, unknown> }[] = [];
  const vaultContext: VaultContext = {
    origin: "https://chit.example",
    primaryChainId: "46630",
    primaryWallet: primary.address.toLowerCase() as `0x${string}`,
    signMessage: (message) => primary.signMessage({ message }),
  };
  let signatures = 0;
  const countingContext: VaultContext = {
    ...vaultContext,
    signMessage: (message) => {
      signatures += 1;
      return primary.signMessage({ message });
    },
  };

  const deps: SetupDeps = {
    fetchQuote: async () => ({ quoteId: "q-1", threshold: "1000", baseFee: "100", discount: "25", netFee: "75", eligible: true }),
    generateAccounts: async (count) =>
      Array.from({ length: count }, (_, i): GeneratedAccount => {
        const privateKey = generatePrivateKey();
        return {
          ownerAddress: privateKeyToAccount(privateKey).address.toLowerCase() as `0x${string}`,
          privateKey,
          salt: `0x${(i + 1).toString(16).padStart(64, "0")}` as `0x${string}`,
        };
      }),
    // Real Vault v1 crypto, not a stub: the journey exercises the exact protocol.
    createVault: (accounts) => createRecoveryVault(countingContext, accounts),
    confirmVault: (envelopeJson, commitment) => confirmRecovery(countingContext, envelopeJson, commitment),
    submit: async (action, body) => {
      submitted.push({ action, body });
      return { campaign: "c-1", state: action === "create" ? "Awaiting recovery confirmation" : "ok" };
    },
  };

  const setup = new CampaignSetup(deps);
  const quote = await setup.connect(primary.address.toLowerCase() as `0x${string}`);
  assert.equal(quote.netFee, "75");

  await setup.configure({
    name: "acceptance-fleet", chainId: 46630, accounts: 5,
    router: `0x${"88".repeat(20)}`, function: "execute(bytes,bytes[],uint256)",
    maxTradeValue: "500000000000000", perAccountGas: "200000000000000",
    totalGas: "1000000000000000", expiry: "2099-12-31T00:00:00.000Z",
  });

  const vault = await setup.downloadVault();
  assert.match(vault.commitment, /^0x[0-9a-f]{64}$/);
  const signaturesAfterDownload = signatures;
  assert.ok(signaturesAfterDownload >= 1, "creating the vault took a wallet signature");

  await setup.create();
  await setup.confirmRecovery();
  assert.ok(signatures > signaturesAfterDownload, "confirmation took a fresh second signature (FR-006)");

  await setup.fund("tx-ref");
  await setup.activate();

  // SC-008 at the boundary: nothing that left the browser contains a key.
  const everything = JSON.stringify(submitted);
  assert.equal(everything.includes("privateKey"), false);
  assert.match(everything, /recoveryVaultCommitment/);
  assert.equal(submitted.map((entry) => entry.action).join(","), "create,confirmRecovery,fund,activate");
});

test("the reporting side closes the loop with legal actions and honest claims", () => {
  const report = buildBuyReport([
    { account: `0x${"01".repeat(20)}`, status: "sponsored", budget: { funded: "10", reserved: "0", spent: "2", unused: "8" } },
  ]);
  assert.equal(report.sponsored, 1);
  assert.equal(report.privacyNote, FLEET_PRIVACY_CLAIM);

  const revoked = buildControlRoomView({
    campaign: "c-1", state: "Revoked",
    budget: { funded: "10", reserved: "0", spent: "2", unused: "8" },
  });
  assert.deepEqual(revoked.availableActions, ["close"]);

  const closed = buildControlRoomView({
    campaign: "c-1", state: "Closed",
    budget: { funded: "10", reserved: "0", spent: "2", unused: "0" }, returnedEth: "8",
  });
  assert.equal(closed.returnedEth, "8");
  assert.deepEqual(closed.availableActions, []);
});
