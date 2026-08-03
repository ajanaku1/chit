import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { OperatorSponsorService } from "../src/operator-sponsor.js";

const CREATOR = privateKeyToAccount(`0x${"21".repeat(32)}`);
const OPERATOR = `0x${"32".repeat(20)}` as const;
const DIGEST = `0x${"43".repeat(32)}` as const;
const HASH = `0x${"54".repeat(32)}` as const;

function fixture() {
  let registrations = 0;
  const service = new OperatorSponsorService({
    creator: CREATOR.address,
    sponsor: OPERATOR,
    budget: 1_000n,
    admissionTtlSeconds: 3_600,
    clock: () => 1_900_000_000,
    chain: {
      admissionDigest: async () => DIGEST,
      register: async () => {
        registrations += 1;
        return { slot: 1, transactionHash: HASH };
      },
    },
  });
  return { service, registrations: () => registrations };
}

describe("operator-controlled second sponsor", () => {
  it("requires a fresh creator signature over the live vault admission digest", async () => {
    const { service, registrations } = fixture();
    const challenge = await service.challenge();
    const signature = await CREATOR.signMessage({ message: { raw: challenge.digest } });
    const result = await service.register({ expiresAt: challenge.expiresAt, signature });

    assert.equal(challenge.sponsor, OPERATOR);
    assert.equal(challenge.budget, "1000");
    assert.equal(result.transactionHash, HASH);
    assert.equal(result.slot, 1);
    assert.equal(registrations(), 1);
  });

  it("rejects another signer before spending operator gas", async () => {
    const { service, registrations } = fixture();
    const challenge = await service.challenge();
    const attacker = privateKeyToAccount(`0x${"65".repeat(32)}`);
    const signature = await attacker.signMessage({ message: { raw: challenge.digest } });

    await assert.rejects(
      service.register({ expiresAt: challenge.expiresAt, signature }),
      /creator signature/i,
    );
    assert.equal(registrations(), 0);
  });
});
