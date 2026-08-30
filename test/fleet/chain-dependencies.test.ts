import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  EVIDENCE_ROLES,
  EvidenceInvalidError,
  parseDependencyEvidence,
} from "../../src/fleet/dependency-evidence.js";

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const fixturePath = join(repoRoot, "test/fleet/fixtures/dependency-evidence.json");
const now = new Date("2026-09-30T00:00:00.000Z");

const readFixture = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;

const liveRecord = () => ({
  version: 1,
  mode: "live",
  chainId: 11155111,
  verifiedAt: "2026-09-29T23:00:00.000Z",
  maxAgeSeconds: 86400,
  allowedClaim: "verified-testnet",
  dependencies: {
    provider: { role: "provider", verified: true, source: "operator RPC", provenance: "FLEET_RPC_URL" },
    entryPoint: {
      role: "entryPoint",
      verified: true,
      address: "0x0000000071727de22e5e9d8baf0edac6f37da032",
      source: "EntryPoint v0.7",
      provenance: "eth_getCode",
    },
    paymaster: {
      role: "paymaster",
      verified: true,
      address: "0x1111111111111111111111111111111111111111",
      source: "Fleet paymaster",
      provenance: "eth_getCode",
    },
    router: {
      role: "router",
      verified: true,
      address: "0x2222222222222222222222222222222222222222",
      source: "router",
      provenance: "eth_getCode",
    },
    venue: {
      role: "venue",
      verified: true,
      address: "0x3333333333333333333333333333333333333333",
      source: "venue",
      provenance: "eth_getCode",
    },
  },
});

const rejects = (input: unknown, when: Date = now): string => {
  try {
    parseDependencyEvidence(input, when);
  } catch (error) {
    assert.ok(error instanceof EvidenceInvalidError);
    assert.equal(error.code, "evidence_invalid");
    return error.reason;
  }
  return assert.fail("expected evidence_invalid");
};

test("the committed fixture record is a valid test-only fixture", async () => {
  const evidence = parseDependencyEvidence(await readFixture(), now);

  assert.equal(evidence.mode, "fixture");
  assert.equal(evidence.testOnly, true);
  assert.equal(evidence.allowedClaim, "test-only-fixture");
  assert.equal(evidence.chainId, 46630, "the committed fixture targets Robinhood Chain testnet");
  assert.deepEqual(Object.keys(evidence.dependencies).sort(), [...EVIDENCE_ROLES].sort());
  for (const role of EVIDENCE_ROLES) {
    const record = evidence.dependencies[role];
    assert.equal(record.role, role);
    assert.ok(record.source.length > 0);
    assert.ok(record.provenance.length > 0);
  }

  // The roles Fleet will actually call on chain are verified deployments; the
  // roles it has not deployed yet are doubles and carry no address.
  assert.equal(evidence.dependencies.entryPoint.address, "0x0000000071727de22e5e9d8baf0edac6f37da032");
  assert.equal(evidence.dependencies.router.address, "0x8876789976decbfcbbbe364623c63652db8c0904");
  assert.equal(evidence.dependencies.provider.address, undefined);
  for (const role of ["paymaster", "venue"] as const) {
    assert.equal(evidence.dependencies[role].verified, false);
    assert.equal(evidence.dependencies[role].address, undefined);
  }
});

test("a fixture double never carries an address, and a fixture must contain one", async () => {
  const fixture = await readFixture();
  const dependencies = fixture["dependencies"] as Record<string, Record<string, unknown>>;

  assert.equal(
    rejects({
      ...fixture,
      dependencies: {
        ...dependencies,
        venue: { ...dependencies["venue"], address: "0x2222222222222222222222222222222222222222" },
      },
    }),
    "unverified_address_forbidden:venue",
  );
  assert.equal(
    rejects({
      ...fixture,
      dependencies: {
        ...dependencies,
        paymaster: { ...dependencies["paymaster"], verified: true, address: "0x1111111111111111111111111111111111111111" },
        venue: { ...dependencies["venue"], verified: true, address: "0x3333333333333333333333333333333333333333" },
      },
    }),
    "fixture_without_double",
  );
  assert.equal(rejects({ ...fixture, testOnly: false }), "fixture_not_test_only");
  assert.equal(rejects({ ...fixture, allowedClaim: "verified-testnet" }), "claim_mode_mismatch");
  assert.equal(rejects({ ...fixture, maxAgeSeconds: 3600 }), "fixture_freshness_forbidden");
});

test("a live record requires verified addresses, a positive freshness window, and no test-only flag", () => {
  const live = liveRecord();

  assert.equal(parseDependencyEvidence(live, now).allowedClaim, "verified-testnet");
  assert.equal(rejects({ ...live, testOnly: true }), "live_marked_test_only");
  assert.equal(rejects({ ...live, allowedClaim: "test-only-fixture" }), "claim_mode_mismatch");
  assert.equal(rejects({ ...live, maxAgeSeconds: 0 }), "live_freshness_required");
  assert.equal(rejects(live, new Date("2026-09-30T23:00:01.000Z")), "evidence_stale");
  assert.equal(rejects(live, new Date("2026-09-29T22:59:59.000Z")), "evidence_stale");
  assert.equal(
    rejects({
      ...live,
      dependencies: {
        ...live.dependencies,
        venue: { role: "venue", verified: true, source: "venue", provenance: "eth_getCode" },
      },
    }),
    "address_required",
  );
  assert.equal(
    rejects({
      ...live,
      dependencies: {
        ...live.dependencies,
        provider: { role: "provider", verified: true, address: "0x4444444444444444444444444444444444444444", source: "rpc", provenance: "p" },
      },
    }),
    "provider_address_forbidden",
  );
  assert.equal(
    rejects({
      ...live,
      dependencies: { ...live.dependencies, venue: { role: "venue", verified: false, source: "double", provenance: "p" } },
    }),
    "live_role_unverified:venue",
  );
});

test("malformed, incomplete, or role-inconsistent records fail closed", async () => {
  const fixture = await readFixture();
  const dependencies = fixture["dependencies"] as Record<string, unknown>;
  const { venue, ...missingVenue } = dependencies as Record<string, unknown> & { venue: unknown };

  assert.equal(rejects(null), "not_an_object");
  assert.equal(rejects({ ...fixture, version: 2 }), "unsupported_version");
  assert.equal(rejects({ ...fixture, mode: "production" }), "unsupported_mode");
  assert.equal(rejects({ ...fixture, chainId: 0 }), "invalid_chain_id");
  assert.equal(rejects({ ...fixture, verifiedAt: "yesterday" }), "invalid_verified_at");
  assert.equal(rejects({ ...fixture, dependencies: missingVenue }), "role_missing:venue");
  assert.equal(
    rejects({ ...fixture, dependencies: { ...dependencies, oracle: { role: "oracle", source: "s", provenance: "p" } } }),
    "unknown_role:oracle",
  );
  assert.equal(
    rejects({ ...fixture, dependencies: { ...dependencies, venue: { role: "router", verified: false, source: "s", provenance: "p" } } }),
    "role_mismatch:venue",
  );
  assert.equal(
    rejects({ ...fixture, dependencies: { ...dependencies, venue: { role: "venue", verified: false, source: "", provenance: "p" } } }),
    "field_missing:venue.source",
  );
  assert.equal(
    rejects({ ...fixture, dependencies: { ...dependencies, venue: { role: "venue", source: "s", provenance: "p" } } }),
    "field_missing:venue.verified",
  );
  assert.ok(venue);
});
