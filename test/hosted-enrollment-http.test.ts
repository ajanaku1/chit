import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostedEnrollmentResponse } from "../src/hosted-enrollment-http.js";

const OWNER = `0x${"11".repeat(20)}` as const;
const SIGNATURE = `0x${"22".repeat(65)}` as const;

describe("hosted enrollment HTTP boundary", () => {
  it("routes a valid challenge without accepting extra fields", async () => {
    let challenged = false;
    const response = await hostedEnrollmentResponse(
      new Request("https://chit.example/api/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "challenge", owner: OWNER }),
      }),
      {
        challenge: async () => {
          challenged = true;
          return { account: OWNER, nonce: "one", expiresAt: 2, message: "sign" };
        },
        enroll: async () => ({ account: OWNER, transactionHash: `0x${"33".repeat(32)}` }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(challenged, true);
    assert.deepEqual(await response.json(), {
      account: OWNER,
      nonce: "one",
      expiresAt: 2,
      message: "sign",
    });
  });

  it("rejects unknown fields before invoking the service", async () => {
    let called = false;
    const response = await hostedEnrollmentResponse(
      new Request("https://chit.example/api/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "challenge", owner: OWNER, slot: 0 }),
      }),
      {
        challenge: async () => {
          called = true;
          throw new Error("unreachable");
        },
        enroll: async () => {
          called = true;
          throw new Error("unreachable");
        },
      },
    );

    assert.equal(response.status, 400);
    assert.equal(called, false);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  });

  it("routes a signed enrollment request", async () => {
    const response = await hostedEnrollmentResponse(
      new Request("https://chit.example/api/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "enroll",
          owner: OWNER,
          nonce: "one",
          expiresAt: 2_000_000_000,
          signature: SIGNATURE,
        }),
      }),
      {
        challenge: async () => {
          throw new Error("unreachable");
        },
        enroll: async (request) => ({
          account: request.owner,
          transactionHash: `0x${"44".repeat(32)}`,
        }),
      },
    );

    assert.equal(response.status, 200);
    const body = await response.json() as { readonly account: string };
    assert.equal(body.account, OWNER);
  });
});
