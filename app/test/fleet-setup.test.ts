import assert from "node:assert/strict";
import test from "node:test";

import { CampaignSetup, SetupError, type SetupDeps } from "../src/fleet/campaign-setup.js";

const owner = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const salt = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;

const quote = (eligible: boolean) => ({
  quoteId: "q-1",
  threshold: "1000",
  baseFee: "100",
  discount: "25",
  netFee: "75",
  eligible,
});

const policyForm = () => ({
  name: "alpha-fleet",
  chainId: 46630,
  accounts: 5,
  router: owner(0x88),
  function: "execute(bytes,bytes[],uint256)",
  maxTradeValue: "1000000000000000",
  perAccountGas: "200000000000000",
  totalGas: "1000000000000000",
  expiry: "2026-12-31T00:00:00.000Z",
});

const makeDeps = (overrides: Partial<SetupDeps> = {}) => {
  const calls: string[] = [];
  let generated = 0;
  const deps: SetupDeps = {
    fetchQuote: async () => {
      calls.push("quote");
      return quote(true);
    },
    generateAccounts: async (count: number) => {
      generated += 1;
      calls.push("generate");
      return Array.from({ length: count }, (_, i) => ({
        ownerAddress: owner(i + 1),
        privateKey: salt(i + 100),
        salt: salt(i + 1),
      }));
    },
    createVault: async () => {
      calls.push("vault");
      return { envelopeJson: `{"version":1}`, commitment: `0x${"3".repeat(64)}` };
    },
    confirmVault: async () => {
      calls.push("confirm");
      return true;
    },
    submit: async (action, body) => {
      calls.push(`submit:${action}`);
      return { campaign: "c-1", state: action === "create" ? "Awaiting recovery confirmation" : "ok", body };
    },
    ...overrides,
  };
  return { deps, calls, generatedCount: () => generated };
};

test("the journey shows the fee quote before anything is created", async () => {
  const { deps, calls } = makeDeps();
  const setup = new CampaignSetup(deps);
  const shown = await setup.connect(owner(0xaa));
  assert.deepEqual(shown, quote(true));
  assert.deepEqual(calls, ["quote"]);
});

test("an ineligible wallet is blocked at connect and nothing else runs", async () => {
  const { deps, calls } = makeDeps({ fetchQuote: async () => quote(false) });
  const setup = new CampaignSetup(deps);
  await setup.connect(owner(0xaa));
  await assert.rejects(() => setup.configure(policyForm()), (error: unknown) => {
    assert.ok(error instanceof SetupError);
    assert.equal(error.reason, "ineligible");
    return true;
  });
  assert.deepEqual(calls, []);
});

test("funding and activation are blocked until the vault is downloaded and confirmed", async () => {
  const { deps } = makeDeps();
  const setup = new CampaignSetup(deps);
  await setup.connect(owner(0xaa));
  await setup.configure(policyForm());
  await setup.create();

  for (const step of ["fund", "activate"] as const) {
    await assert.rejects(() => setup[step]("ref"), (error: unknown) => {
      assert.ok(error instanceof SetupError);
      assert.equal(error.reason, "vault_not_confirmed");
      return true;
    });
  }

  await setup.downloadVault();
  await assert.rejects(() => setup.fund("ref"), (error: unknown) => {
    assert.ok(error instanceof SetupError);
    assert.equal(error.reason, "vault_not_confirmed");
    return true;
  }, "download alone is not confirmation");

  await setup.confirmRecovery();
  assert.equal((await setup.fund("ref")).state, "ok");
  assert.equal((await setup.activate()).state, "ok");
});

test("the create payload carries commitments and public data, never a private key", async () => {
  const submitted: Record<string, unknown>[] = [];
  const { deps } = makeDeps({
    submit: async (action, body) => {
      submitted.push({ action, ...body });
      return { campaign: "c-1", state: "Awaiting recovery confirmation" };
    },
  });
  const setup = new CampaignSetup(deps);
  await setup.connect(owner(0xaa));
  await setup.configure(policyForm());
  await setup.downloadVault();
  await setup.create();

  const create = submitted.find((entry) => entry["action"] === "create");
  assert.ok(create);
  const serialized = JSON.stringify(create);
  assert.equal(serialized.includes("privateKey"), false);
  assert.equal(serialized.includes(salt(100)), false, "no generated key material leaves the browser");
  assert.ok(serialized.includes("recoveryVaultCommitment"));
});

test("re-entering the journey resumes the same accounts instead of generating twice", async () => {
  const { deps, generatedCount } = makeDeps();
  const setup = new CampaignSetup(deps);
  await setup.connect(owner(0xaa));
  await setup.configure(policyForm());
  await setup.downloadVault();
  await setup.create();
  await setup.create();
  await setup.downloadVault();
  assert.equal(generatedCount(), 1, "a reload never mints a second fleet");
});

test("the policy form is validated before account generation", async () => {
  const { deps, calls } = makeDeps();
  const setup = new CampaignSetup(deps);
  await setup.connect(owner(0xaa));
  await assert.rejects(() => setup.configure({ ...policyForm(), accounts: 4 }), (error: unknown) => {
    assert.ok(error instanceof SetupError);
    return true;
  });
  await assert.rejects(() => setup.configure({ ...policyForm(), name: "" }), (error: unknown) => {
    assert.ok(error instanceof SetupError);
    assert.equal(error.reason, "invalid_name");
    return true;
  });
  assert.equal(calls.includes("generate"), false);
});
