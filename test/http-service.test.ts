import assert from "node:assert/strict";
import { type Server } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createOperatorHttpServer } from "../src/http-service.js";

interface RecordedCall {
  readonly kind: string;
  readonly round?: string;
  readonly body?: unknown;
}

interface TestServerOptions {
  readonly allowedOrigins: readonly string[];
  readonly api: {
    execute(
      request: RecordedCall,
      context?: { readonly requestId: string; readonly signal: AbortSignal },
    ): Promise<unknown>;
  };
  readonly logger: { log(record: object): void };
  readonly maxBodyBytes?: number;
  readonly deadlineMs?: number;
  readonly requestId?: () => string;
  readonly rateLimits?: {
    readonly windowMs: number;
    readonly perIp: number;
    readonly perRound: number;
    readonly perWallet: number;
  };
}

const createServer = createOperatorHttpServer as unknown as (
  options: TestServerOptions,
) => Server;
const HTTP_ROUND = `0x${"aa".repeat(32)}`;
const OPERATION_WIRE = {
  sender: `0x${"10".repeat(20)}`,
  nonce: "0",
  factory: `0x${"20".repeat(20)}`,
  factoryData: "0x1234",
  callData: "0x5678",
  callGasLimit: "150000",
  verificationGasLimit: "400000",
  preVerificationGas: "70000",
  maxFeePerGas: "2000000000",
  maxPriorityFeePerGas: "1000000000",
  paymaster: `0x${"30".repeat(20)}`,
  paymasterVerificationGasLimit: "200000",
  paymasterPostOpGasLimit: "80000",
  paymasterData: "0x",
  signature: "0x",
};

const OPERATION_TYPED = {
  ...OPERATION_WIRE,
  nonce: 0n,
  callGasLimit: 150_000n,
  verificationGasLimit: 400_000n,
  preVerificationGas: 70_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  paymasterVerificationGasLimit: 200_000n,
  paymasterPostOpGasLimit: 80_000n,
};

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("operator HTTP transport", () => {
  it("exports a dependency-free server constructor", async () => {
    const modulePath = "../src/http-service.js";
    const transport = await import(modulePath).catch(() => null);

    assert.notEqual(transport, null);
    assert.equal(typeof transport?.createOperatorHttpServer, "function");
  });

  it("rejects an untrusted browser origin before invoking the API", async () => {
    const calls: RecordedCall[] = [];
    const server = await Promise.resolve()
      .then(() =>
        createServer({
          allowedOrigins: ["https://chit.example"],
          api: {
            async execute(request) {
              calls.push(request);
              return {};
            },
          },
          logger: { log() {} },
        }),
      )
      .catch(() => null);

    assert.notEqual(server, null);
    if (server === null) throw new Error("Server construction failed");
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/v1/rounds/${HTTP_ROUND}/sponsors`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: "{}",
      });

      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.deepEqual(calls, []);
    } finally {
      server.close();
    }
  });

  it("decodes a sponsor registration into the typed service request", async () => {
    const calls: RecordedCall[] = [];
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: {
        async execute(request) {
          calls.push(request);
          return { registered: true };
        },
      },
      logger: { log() {} },
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/v1/rounds/${HTTP_ROUND}/sponsors`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chit.example",
        },
        body: JSON.stringify({
          sponsor: `0x${"11".repeat(20)}`,
          slot: 2,
          registrationTx: `0x${"22".repeat(32)}`,
          declaredBudget: "100",
          admission: {
            nonce: "creator-1",
            expiresAt: 2_000_000_000,
            signature: `0x${"33".repeat(65)}`,
          },
          sponsorProof: {
            nonce: "sponsor-1",
            expiresAt: 2_000_000_000,
            signature: `0x${"44".repeat(65)}`,
          },
        }),
      });

      assert.equal(response.status, 201);
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        "https://chit.example",
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(calls, [
        {
          kind: "register-sponsor",
          round: HTTP_ROUND,
          body: {
            round: HTTP_ROUND,
            sponsor: `0x${"11".repeat(20)}`,
            slot: 2,
            registrationTx: `0x${"22".repeat(32)}`,
            declaredBudget: 100n,
            admission: {
              nonce: "creator-1",
              expiresAt: 2_000_000_000,
              signature: `0x${"33".repeat(65)}`,
            },
            sponsorProof: {
              nonce: "sponsor-1",
              expiresAt: 2_000_000_000,
              signature: `0x${"44".repeat(65)}`,
            },
          },
        },
      ]);
      assert.deepEqual(await response.json(), { registered: true });
    } finally {
      server.close();
    }
  });

  it("serves trusted preflight and public round reads", async () => {
    const calls: RecordedCall[] = [];
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: {
        async execute(request) {
          calls.push(request);
          return { state: "active" };
        },
      },
      logger: { log() {} },
    });
    const baseUrl = await listen(server);
    try {
      const preflight = await fetch(`${baseUrl}/v1/rounds/${HTTP_ROUND}`, {
        method: "OPTIONS",
        headers: {
          origin: "https://chit.example",
          "access-control-request-method": "GET",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(
        preflight.headers.get("access-control-allow-methods"),
        "GET, POST, OPTIONS",
      );

      const response = await fetch(`${baseUrl}/v1/rounds/${HTTP_ROUND}`, {
        headers: { origin: "https://chit.example" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { state: "active" });
      assert.deepEqual(calls, [{ kind: "get-round", round: HTTP_ROUND }]);
    } finally {
      server.close();
    }
  });

  it("decodes an owner-bound invite request", async () => {
    const calls: RecordedCall[] = [];
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: {
        async execute(request) {
          calls.push(request);
          return { token: "opaque", account: `0x${"55".repeat(20)}` };
        },
      },
      logger: { log() {} },
    });
    const baseUrl = await listen(server);
    try {
      const body = {
        sponsor: `0x${"11".repeat(20)}`,
        slot: 2,
        owner: `0x${"22".repeat(20)}`,
        inviteNonce: "invite-1",
        inviteExpiresAt: 2_000_000_000,
        sponsorProof: {
          nonce: "sponsor-2",
          expiresAt: 2_000_000_000,
          signature: `0x${"33".repeat(65)}`,
        },
      };
      const response = await fetch(`${baseUrl}/v1/rounds/${HTTP_ROUND}/invites`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chit.example",
        },
        body: JSON.stringify(body),
      });

      assert.equal(response.status, 201);
      assert.deepEqual(calls, [
        {
          kind: "issue-invite",
          round: HTTP_ROUND,
          body: { ...body, round: HTTP_ROUND },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it("routes operator derivation without exposing key material", async () => {
    const calls: RecordedCall[] = [];
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: {
        async execute(request) {
          calls.push(request);
          return { operator: `0x${"44".repeat(20)}` };
        },
      },
      logger: { log() {} },
    });
    const baseUrl = await listen(server);
    try {
      const body = {
        creator: `0x${"11".repeat(20)}`,
        roundSalt: `0x${"22".repeat(32)}`,
      };
      const response = await fetch(`${baseUrl}/v1/operators/derive`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://chit.example",
        },
        body: JSON.stringify(body),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(calls, [{ kind: "derive-operator", body }]);
      assert.deepEqual(await response.json(), {
        operator: `0x${"44".repeat(20)}`,
      });
    } finally {
      server.close();
    }
  });

  it("normalizes canonical v0.7 operations for prepare and submit", async () => {
    const calls: RecordedCall[] = [];
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: {
        async execute(request) {
          calls.push(request);
          return { accepted: true };
        },
      },
      logger: { log() {} },
    });
    const baseUrl = await listen(server);
    try {
      const owner = `0x${"40".repeat(20)}`;
      const prepare = await fetch(
        `${baseUrl}/v1/rounds/${HTTP_ROUND}/user-operations/prepare`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://chit.example",
          },
          body: JSON.stringify({ token: "opaque-secret", owner, operation: OPERATION_WIRE }),
        },
      );
      const operationKey = `0x${"50".repeat(32)}`;
      const signedOperation = { ...OPERATION_WIRE, signature: "0x1234" };
      const submit = await fetch(
        `${baseUrl}/v1/rounds/${HTTP_ROUND}/user-operations/submit`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://chit.example",
          },
          body: JSON.stringify({ operationKey, operation: signedOperation }),
        },
      );

      assert.equal(prepare.status, 201);
      assert.equal(submit.status, 202);
      assert.deepEqual(calls, [
        {
          kind: "prepare-operation",
          round: HTTP_ROUND,
          body: {
            round: HTTP_ROUND,
            token: "opaque-secret",
            owner,
            operation: OPERATION_TYPED,
          },
        },
        {
          kind: "submit-operation",
          round: HTTP_ROUND,
          body: {
            operationKey,
            operation: { ...OPERATION_TYPED, signature: "0x1234" },
          },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it("routes signed enrollment, settlement, and recovery commands", async () => {
    const calls: RecordedCall[] = [];
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: {
        async execute(request) {
          calls.push(request);
          return { transactionHash: `0x${"60".repeat(32)}` };
        },
      },
      logger: { log() {} },
    });
    const baseUrl = await listen(server);
    const proof = {
      nonce: "wallet-1",
      expiresAt: 2_000_000_000,
      signature: `0x${"70".repeat(65)}`,
    };
    const owner = `0x${"80".repeat(20)}`;
    const account = `0x${"90".repeat(20)}`;
    try {
      const requests = [
        {
          path: "enroll",
          body: { token: "opaque-secret", owner, account, ownerProof: proof },
        },
        { path: "settle", body: { creatorProof: proof } },
        {
          path: "operator-gas/recover",
          body: { closedBlockHash: `0x${"a0".repeat(32)}`, creatorProof: proof },
        },
      ];
      for (const request of requests) {
        const response = await fetch(
          `${baseUrl}/v1/rounds/${HTTP_ROUND}/${request.path}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://chit.example",
            },
            body: JSON.stringify(request.body),
          },
        );
        assert.equal(response.status, 202);
      }

      assert.deepEqual(calls, [
        {
          kind: "enroll-account",
          round: HTTP_ROUND,
          body: { round: HTTP_ROUND, token: "opaque-secret", owner, account, ownerProof: proof },
        },
        {
          kind: "settle-round",
          round: HTTP_ROUND,
          body: { round: HTTP_ROUND, creatorProof: proof },
        },
        {
          kind: "recover-operator-gas",
          round: HTTP_ROUND,
          body: {
            round: HTTP_ROUND,
            closedBlockHash: `0x${"a0".repeat(32)}`,
            creatorProof: proof,
          },
        },
      ]);
    } finally {
      server.close();
    }
  });

  it("rejects oversized and non-exact request bodies before the API", async () => {
    const calls: RecordedCall[] = [];
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: {
        async execute(request) {
          calls.push(request);
          return {};
        },
      },
      logger: { log() {} },
      maxBodyBytes: 512,
    });
    const baseUrl = await listen(server);
    const headers = {
      "content-type": "application/json",
      origin: "https://chit.example",
    };
    try {
      const oversized = await fetch(`${baseUrl}/v1/operators/derive`, {
        method: "POST",
        headers,
        body: JSON.stringify({ padding: "x".repeat(1_000) }),
      });
      assert.equal(oversized.status, 413);

      const unknownField = await fetch(`${baseUrl}/v1/operators/derive`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          creator: `0x${"11".repeat(20)}`,
          roundSalt: `0x${"22".repeat(32)}`,
          masterSecret: "must-never-be-accepted",
        }),
      });
      assert.equal(unknownField.status, 400);
      assert.deepEqual(calls, []);
    } finally {
      server.close();
    }
  });

  it("aborts work at the configured deadline and returns a stable timeout", async () => {
    let signal: AbortSignal | undefined;
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: {
        async execute(_request, context) {
          signal = context?.signal;
          await new Promise(() => {});
        },
      },
      logger: { log() {} },
      deadlineMs: 20,
      requestId: () => "request-timeout",
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/v1/rounds/${HTTP_ROUND}`, {
        headers: { origin: "https://chit.example" },
      });

      assert.equal(response.status, 504);
      assert.equal(signal?.aborted, true);
      assert.deepEqual(await response.json(), {
        error: { code: "deadline_exceeded", message: "Request deadline exceeded" },
      });
    } finally {
      server.close();
    }
  });

  it("rate-limits independently by IP, wallet, and round", async () => {
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: { async execute() { return { ok: true }; } },
      logger: { log() {} },
      rateLimits: { windowMs: 60_000, perIp: 10, perRound: 1, perWallet: 1 },
    });
    const baseUrl = await listen(server);
    const headers = { origin: "https://chit.example" };
    const jsonHeaders = { ...headers, "content-type": "application/json" };
    const otherRound = `0x${"bb".repeat(32)}`;
    try {
      assert.equal(
        (await fetch(`${baseUrl}/v1/rounds/${HTTP_ROUND}`, { headers })).status,
        200,
      );
      assert.equal(
        (await fetch(`${baseUrl}/v1/rounds/${HTTP_ROUND}`, { headers })).status,
        429,
      );
      assert.equal(
        (await fetch(`${baseUrl}/v1/rounds/${otherRound}`, { headers })).status,
        200,
      );

      const derive = (creator: string) =>
        fetch(`${baseUrl}/v1/operators/derive`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ creator, roundSalt: `0x${"cc".repeat(32)}` }),
        });
      assert.equal((await derive(`0x${"11".repeat(20)}`)).status, 200);
      assert.equal((await derive(`0x${"11".repeat(20)}`)).status, 429);
      assert.equal((await derive(`0x${"22".repeat(20)}`)).status, 200);
    } finally {
      server.close();
    }

    const ipLimited = createServer({
      allowedOrigins: ["https://chit.example"],
      api: { async execute() { return { ok: true }; } },
      logger: { log() {} },
      rateLimits: { windowMs: 60_000, perIp: 1, perRound: 10, perWallet: 10 },
    });
    const ipUrl = await listen(ipLimited);
    try {
      assert.equal(
        (await fetch(`${ipUrl}/v1/rounds/${HTTP_ROUND}`, { headers })).status,
        200,
      );
      assert.equal(
        (await fetch(`${ipUrl}/v1/rounds/${otherRound}`, { headers })).status,
        429,
      );
    } finally {
      ipLimited.close();
    }
  });

  it("logs only bounded public request metadata", async () => {
    const logs: object[] = [];
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: { async execute() { return { accepted: true }; } },
      logger: { log(record) { logs.push(record); } },
      requestId: () => "request-safe-log",
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(
        `${baseUrl}/v1/rounds/${HTTP_ROUND}/user-operations/prepare`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://chit.example",
          },
          body: JSON.stringify({
            token: "opaque-do-not-log",
            owner: `0x${"40".repeat(20)}`,
            operation: OPERATION_WIRE,
          }),
        },
      );
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("x-request-id"), "request-safe-log");
      assert.equal(logs.length, 1);
      const serialized = JSON.stringify(logs);
      assert.doesNotMatch(serialized, /opaque-do-not-log|signature|paymasterData/);
      assert.match(serialized, /request-safe-log/);
      assert.match(serialized, /prepare-operation/);
      assert.match(serialized, new RegExp(HTTP_ROUND));
    } finally {
      server.close();
    }
  });

  it("exposes a dependency-backed health report without requiring browser origin", async () => {
    const calls: RecordedCall[] = [];
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: {
        async execute(request) {
          calls.push(request);
          return {
            status: "ok",
            checks: { rpc: "ok", nox: "ok", operator: "ok", bundler: "ok" },
          };
        },
      },
      logger: { log() {} },
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/health`);

      assert.equal(response.status, 200);
      assert.deepEqual(calls, [{ kind: "health" }]);
      assert.deepEqual(await response.json(), {
        status: "ok",
        checks: { rpc: "ok", nox: "ok", operator: "ok", bundler: "ok" },
      });
    } finally {
      server.close();
    }
  });

  it("keeps serving when the injected log sink fails", async () => {
    const server = createServer({
      allowedOrigins: ["https://chit.example"],
      api: { async execute() { return { status: "ok" }; } },
      logger: { log() { throw new Error("log sink unavailable"); } },
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      server.close();
    }
  });
});
