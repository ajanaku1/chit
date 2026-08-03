import { getAddress, isHex, size, type Address, type Hex } from "viem";
import {
  type EnrollHostedAccountRequest,
  type EnrollmentChallenge,
  type HostedEnrollmentResult,
} from "./hosted-enrollment.js";

interface HostedEnrollmentApi {
  challenge(owner: Address): Promise<EnrollmentChallenge>;
  enroll(request: EnrollHostedAccountRequest): Promise<HostedEnrollmentResult>;
}

class InvalidRequestError extends Error {}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidRequestError("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new InvalidRequestError("Request fields are invalid");
  }
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidRequestError(`${field} is invalid`);
  }
  return value;
}

function addressField(body: Record<string, unknown>): Address {
  try {
    return getAddress(stringField(body, "owner"));
  } catch {
    throw new InvalidRequestError("owner is invalid");
  }
}

function signatureField(body: Record<string, unknown>): Hex {
  const value = stringField(body, "signature");
  if (!isHex(value) || size(value) !== 65) {
    throw new InvalidRequestError("signature is invalid");
  }
  return value;
}

function expiryField(body: Record<string, unknown>): number {
  const value = body.expiresAt;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new InvalidRequestError("expiresAt is invalid");
  }
  return Number(value);
}

function json(value: object, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function execute(body: Record<string, unknown>, api: HostedEnrollmentApi): Promise<object> {
  const action = stringField(body, "action");
  if (action === "challenge") {
    exactKeys(body, ["action", "owner"]);
    return api.challenge(addressField(body));
  }
  if (action === "enroll") {
    exactKeys(body, ["action", "owner", "nonce", "expiresAt", "signature"]);
    return api.enroll({
      owner: addressField(body),
      nonce: stringField(body, "nonce"),
      expiresAt: expiryField(body),
      signature: signatureField(body),
    });
  }
  throw new InvalidRequestError("action is invalid");
}

export async function hostedEnrollmentResponse(
  request: Request,
  api: HostedEnrollmentApi,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = objectBody(await request.json());
    return json(await execute(body, api));
  } catch (error) {
    if (error instanceof InvalidRequestError || error instanceof SyntaxError) {
      return json({ error: "invalid_request" }, 400);
    }
    console.error("hosted enrollment request failed", error);
    return json({ error: "enrollment_unavailable" }, 503);
  }
}
