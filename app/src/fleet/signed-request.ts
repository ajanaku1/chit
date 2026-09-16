/**
 * Browser-side signed Fleet requests.
 *
 * The service issues a challenge and returns the exact string to sign, so this
 * module never reconstructs the challenge format or holds the service's origin
 * and chain id. It computes only the payload hash, which must be taken over the
 * same canonical bytes the service uses.
 */

import { keccak256, stringToBytes, type Hex } from "viem";

import { fleetApi, SIGN_IS_FREE, walletProvider, withWalletPrompt, type Eip1193 } from "./page-shared.js";

/** Recursively key-sorted JSON with no whitespace; mirrors the service exactly. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, entry]) => `${JSON.stringify(name)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const payloadHash = (body: unknown): Hex => keccak256(stringToBytes(canonicalJson(body)));

export class RequestFailed extends Error {
  readonly status: number;
  readonly code: string;

  readonly reason: string | undefined;

  constructor(status: number, code: string, reason?: string) {
    super(reason ? `${status} ${code}: ${reason}` : `${status} ${code}`);
    this.name = "RequestFailed";
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

/** What each signature is for, in the words the trader sees while the wallet asks. */
const PURPOSE: Record<string, string> = {
  balance: "show your Chit balance",
  list: "show your fleets",
  holdings: "show what your fleet holds",
  tokenQuote: "quote this token",
  order: "place this order",
  trade: "run the next part of your order",
  withdraw: "withdraw from your Chit balance",
  create: "register your fleet",
  confirmRecovery: "tell Chit your backup is safe",
  activate: "launch your fleet",
  topUp: "top up this fleet",
  pause: "pause this fleet",
  resume: "resume this fleet",
  revoke: "stop this fleet",
  close: "close this fleet",
};

export const promptFor = (action: string): string =>
  `Check your wallet: sign to ${PURPOSE[action] ?? "continue"}. ${SIGN_IS_FREE}`;

const ethereum = (): Eip1193 => {
  const eth = walletProvider();
  if (!eth) throw new RequestFailed(0, "wallet_unavailable");
  return eth;
};

/**
 * Runs one signed action: asks for a challenge over this exact body, has the
 * wallet sign the string the service returned, then sends the action.
 */
export const signedFleetApi = async (
  wallet: Hex,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const hash = payloadHash(body);
  const challenge = await fleetApi("challenge", {
    action: "challenge",
    body: { primaryWallet: wallet, action, payloadHash: hash },
  });
  if (challenge.status !== 200) {
    throw new RequestFailed(challenge.status, String(challenge.body["code"] ?? "challenge_failed"));
  }

  const eth = ethereum();
  const signature = (await withWalletPrompt(promptFor(action), () =>
    eth.request({ method: "personal_sign", params: [String(challenge.body["challenge"]), wallet] }),
  )) as Hex;

  const auth = {
    primaryWallet: wallet,
    nonce: String(challenge.body["nonce"]),
    issuedAt: String(challenge.body["issuedAt"]),
    expiresAt: String(challenge.body["expiresAt"]),
    action,
    payloadHash: hash,
    signature,
  };
  const result = await fleetApi(action, { action, auth, body });
  if (result.status < 200 || result.status >= 300) {
    throw new RequestFailed(result.status, String(result.body["code"] ?? `status_${result.status}`), typeof result.body["reason"] === "string" ? result.body["reason"] : undefined);
  }
  return result.body;
};
