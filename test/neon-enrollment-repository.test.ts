import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NeonEnrollmentRepository } from "../src/neon-enrollment-repository.js";

const OWNER = `0x${"11".repeat(20)}` as const;
const ACCOUNT = `0x${"22".repeat(20)}` as const;
const ROUND = `0x${"33".repeat(32)}`;
const HASH = `0x${"44".repeat(32)}` as const;

describe("Neon enrollment repository", () => {
  it("maps an atomic begin and confirmed replay from database rows", async () => {
    const calls: string[] = [];
    let state = "ready";
    let transactionHash: string | null = null;
    const sql = {
      query: async (query: string): Promise<readonly Record<string, unknown>[]> => {
        calls.push(query);
        if (query.includes("CREATE TABLE")) return [];
        if (query.includes("INSERT INTO hosted_enrollments")) return [];
        if (query.includes("WITH started AS")) {
          const started = state === "ready" || state === "failed";
          if (started) state = "pending";
          return [{
            round: ROUND,
            owner: OWNER,
            account: ACCOUNT,
            nonce: "one",
            expires_at: 2_000_000_000,
            state,
            transaction_hash: transactionHash,
            started,
          }];
        }
        if (query.includes("state = 'confirmed'")) {
          state = "confirmed";
          transactionHash = HASH;
          return [{ nonce: "one" }];
        }
        throw new Error(`Unexpected SQL: ${query}`);
      },
    };
    const repository = new NeonEnrollmentRepository(sql);
    const identity = {
      round: ROUND,
      owner: OWNER,
      account: ACCOUNT,
      nonce: "one",
      expiresAt: 2_000_000_000,
    };

    await repository.initialize();
    await repository.create({ ...identity, state: "ready" });
    assert.equal((await repository.begin(identity))?.started, true);
    await repository.complete("one", HASH);
    const replay = await repository.begin(identity);

    assert.equal(replay?.started, false);
    assert.equal(replay?.record.state, "confirmed");
    assert.equal(replay?.record.transactionHash, HASH);
    assert.equal(calls.length, 5);
  });
});
