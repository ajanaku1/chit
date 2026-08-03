import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import {
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import {
  validatePreparedOperation,
  type OperationPolicy,
} from "./operation-policy.js";
import { buildPaymasterPrefix } from "./user-operation.js";

interface OperatorContext {
  readonly chainId: number;
  readonly factory: Address;
  readonly creator: Address;
  readonly roundSalt: string;
}

interface PaymasterAuthorizerOptions {
  readonly masterSecret: Uint8Array;
  readonly operatorContext: OperatorContext;
  readonly entryPoint: Address;
  readonly paymaster: Address;
}

interface AuthorizationDigestInput {
  readonly operation: UserOperation<"0.7">;
  readonly entryPoint: Address;
  readonly chainId: number;
  readonly paymaster: Address;
  readonly maximumCost: bigint;
  readonly validUntil: number;
}

export interface PaymasterAuthorization {
  readonly signature: Hex;
  readonly paymasterData: Hex;
}

interface InviteCodecOptions {
  readonly masterSecret: Uint8Array;
  readonly origin: string;
  readonly chainId: number;
  readonly factory: Address;
}

export interface InvitePayload {
  readonly round: string;
  readonly sponsor: Address;
  readonly sponsorSlot: number;
  readonly owner: Address;
  readonly account: Address;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly action: string;
}

interface StoredInvite extends InvitePayload {
  readonly version: 1;
  readonly chainId: number;
  readonly factory: Address;
}

interface InviteExpectation {
  readonly round: string;
  readonly owner: Address;
  readonly account: Address;
  readonly action: string;
  readonly now: number;
}

export interface SignedRequestFields {
  readonly origin: string;
  readonly chainId: number;
  readonly factory: Address;
  readonly round: string;
  readonly bodyHash: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

const CURVE_ORDER = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);
const INVITE_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AUTHORIZATION_TYPEHASH = keccak256(
  toHex(
    "ChitAuthorization(uint256 chainId,address entryPoint,address paymaster,bytes32 userOpHash,bytes32 paymasterFieldsHash,uint256 maxCost,uint48 validUntil)",
  ),
);
const USER_OPERATION_TYPEHASH = keccak256(
  toHex(
    "ChitUserOperation(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees)",
  ),
);
const AUTHORIZATION_ABI = [
  { type: "bytes32" },
  { type: "uint256" },
  { type: "address" },
  { type: "address" },
  { type: "bytes32" },
  { type: "bytes32" },
  { type: "uint256" },
  { type: "uint48" },
] as const;

function requireSecret(secret: Uint8Array): Buffer {
  if (secret.byteLength < 32) {
    throw new RangeError("Service master secret must be at least 32 bytes");
  }
  return Buffer.from(secret);
}

function domain(parts: readonly (string | number)[]): string {
  return parts.map(String).join("\n");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Request body number is not finite");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("Request body contains an unsupported value");
}

export function hashRequestBody(body: object): Hex {
  return keccak256(toHex(canonicalJson(body)));
}

function hmac(secret: Uint8Array, value: string): Buffer {
  return createHmac("sha256", requireSecret(secret)).update(value).digest();
}

export function deriveOperatorAddress(
  masterSecret: Uint8Array,
  context: OperatorContext,
): Address {
  return deriveOperatorAccount(masterSecret, context).address;
}

export function deriveOperatorAccount(
  masterSecret: Uint8Array,
  context: OperatorContext,
) {
  return privateKeyToAccount(deriveOperatorPrivateKey(masterSecret, context));
}

function deriveOperatorPrivateKey(
  masterSecret: Uint8Array,
  context: OperatorContext,
): Hex {
  const digest = hmac(
    masterSecret,
    domain([
      "CHIT_OPERATOR_V1",
      context.chainId,
      context.factory.toLowerCase(),
      context.creator.toLowerCase(),
      context.roundSalt.toLowerCase(),
    ]),
  );
  const scalar = (BigInt(`0x${digest.toString("hex")}`) % (CURVE_ORDER - 1n)) + 1n;
  return toHex(scalar, { size: 32 });
}

function userOperationDigest(operation: UserOperation<"0.7">): Hex {
  const packed = toPackedUserOperation(operation);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        USER_OPERATION_TYPEHASH,
        operation.sender,
        operation.nonce,
        keccak256(packed.initCode),
        keccak256(packed.callData),
        packed.accountGasLimits,
        packed.preVerificationGas,
        packed.gasFees,
      ],
    ),
  );
}

export function authorizationDigest(input: AuthorizationDigestInput): Hex {
  const operation = input.operation;
  const paymasterPrefix = buildPaymasterPrefix(
    input.paymaster,
    operation.paymasterVerificationGasLimit ?? 0n,
    operation.paymasterPostOpGasLimit ?? 0n,
  );
  return keccak256(
    encodeAbiParameters(AUTHORIZATION_ABI, [
      AUTHORIZATION_TYPEHASH,
      BigInt(input.chainId),
      input.entryPoint,
      input.paymaster,
      userOperationDigest(operation),
      keccak256(paymasterPrefix),
      input.maximumCost,
      input.validUntil,
    ]),
  );
}

export class PaymasterAuthorizer {
  readonly address: Address;
  private readonly account;

  constructor(private readonly options: PaymasterAuthorizerOptions) {
    this.account = privateKeyToAccount(
      deriveOperatorPrivateKey(options.masterSecret, options.operatorContext),
    );
    this.address = this.account.address;
  }

  async authorize(
    operation: UserOperation<"0.7">,
    policy: OperationPolicy,
  ): Promise<PaymasterAuthorization> {
    if (policy.paymaster.toLowerCase() !== this.options.paymaster.toLowerCase()) {
      throw new Error("Policy paymaster does not match authorizer context");
    }
    validatePreparedOperation(operation, policy);
    const digest = authorizationDigest({
      operation,
      entryPoint: this.options.entryPoint,
      chainId: this.options.operatorContext.chainId,
      paymaster: this.options.paymaster,
      maximumCost: policy.maximumCost,
      validUntil: policy.validUntil,
    });
    const signature = await this.account.signMessage({ message: { raw: digest } });
    const paymasterData = encodeAbiParameters(
      [{ type: "uint48" }, { type: "bytes" }],
      [policy.validUntil, signature],
    );
    return { signature, paymasterData };
  }
}

export class InviteCodec {
  private readonly key: Buffer;
  private readonly aad: Buffer;
  private readonly options: InviteCodecOptions;

  constructor(options: InviteCodecOptions) {
    this.options = options;
    const context = domain([
      "CHIT_INVITE_KEY_V1",
      options.origin,
      options.chainId,
      options.factory.toLowerCase(),
    ]);
    this.key = hmac(options.masterSecret, context);
    this.aad = Buffer.from(context);
  }

  issue(payload: InvitePayload): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad);
    const stored = {
      ...payload,
      version: INVITE_VERSION,
      chainId: this.options.chainId,
      factory: getAddress(this.options.factory),
    } satisfies StoredInvite;
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(stored), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from([INVITE_VERSION]),
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]).toString("base64url");
  }

  open(token: string, expected: InviteExpectation): InvitePayload {
    const stored = this.decrypt(token);
    if (stored.chainId !== this.options.chainId) {
      throw new Error("Invite chain does not match service context");
    }
    if (stored.factory.toLowerCase() !== this.options.factory.toLowerCase()) {
      throw new Error("Invite factory does not match service context");
    }
    if (stored.round.toLowerCase() !== expected.round.toLowerCase()) {
      throw new Error("Invite round does not match request");
    }
    if (stored.owner.toLowerCase() !== expected.owner.toLowerCase()) {
      throw new Error("Invite owner does not match request");
    }
    if (stored.account.toLowerCase() !== expected.account.toLowerCase()) {
      throw new Error("Invite account does not match request");
    }
    if (stored.action !== expected.action) {
      throw new Error("Invite action does not match request");
    }
    if (stored.expiresAt < expected.now) throw new Error("Invite has expired");
    const { version: _version, chainId: _chainId, factory: _factory, ...payload } =
      stored;
    return payload;
  }

  private decrypt(token: string): StoredInvite {
    try {
      const record = Buffer.from(token, "base64url");
      if (record.toString("base64url") !== token) {
        throw new Error("Invite token encoding is not canonical");
      }
      if (record[0] !== INVITE_VERSION) throw new Error("Unknown invite version");
      const nonce = record.subarray(1, 1 + NONCE_BYTES);
      const tag = record.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
      const ciphertext = record.subarray(1 + NONCE_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(this.aad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8")) as StoredInvite;
    } catch (error) {
      throw new Error("Invite token could not be authenticated", { cause: error });
    }
  }
}

export function buildRequestMessage(fields: SignedRequestFields): string {
  return domain([
    "CHIT_REQUEST_V1",
    fields.origin,
    fields.chainId,
    fields.factory.toLowerCase(),
    fields.round.toLowerCase(),
    fields.bodyHash.toLowerCase(),
    fields.nonce,
    fields.expiresAt,
  ]);
}

export async function verifyRequestSignature(
  fields: SignedRequestFields,
  signature: Hex,
  expectedSigner: Address,
  now: number,
): Promise<void> {
  if (fields.expiresAt < now) throw new Error("Signed request has expired");
  const valid = await verifyMessage({
    address: expectedSigner,
    message: buildRequestMessage(fields),
    signature,
  });
  if (!valid) throw new Error("Request signature is invalid");
}
