import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getAddress, isHex, size, type Hex } from "viem";
import { type UserOperation } from "viem/account-abstraction";
import {
  type IssueInviteRequest,
  type PrepareOperationRequest,
  type RegisterSponsorRequest,
  type WalletProof,
} from "./operator-service.js";

export interface RegisterSponsorApiRequest {
  readonly kind: "register-sponsor";
  readonly round: string;
  readonly body: RegisterSponsorRequest;
}

export interface GetRoundApiRequest {
  readonly kind: "get-round";
  readonly round: string;
}

export interface IssueInviteApiRequest {
  readonly kind: "issue-invite";
  readonly round: string;
  readonly body: IssueInviteRequest;
}

export interface DeriveOperatorApiRequest {
  readonly kind: "derive-operator";
  readonly body: {
    readonly creator: ReturnType<typeof getAddress>;
    readonly roundSalt: Hex;
  };
}

export interface PrepareOperationApiRequest {
  readonly kind: "prepare-operation";
  readonly round: string;
  readonly body: PrepareOperationRequest;
}

export interface SubmitOperationApiRequest {
  readonly kind: "submit-operation";
  readonly round: string;
  readonly body: {
    readonly operationKey: Hex;
    readonly operation: UserOperation<"0.7">;
  };
}

export interface EnrollAccountRequest {
  readonly round: string;
  readonly token: string;
  readonly owner: ReturnType<typeof getAddress>;
  readonly account: ReturnType<typeof getAddress>;
  readonly ownerProof: WalletProof;
}

export interface SettleRoundRequest {
  readonly round: string;
  readonly creatorProof: WalletProof;
}

export interface RecoverOperatorGasRequest extends SettleRoundRequest {
  readonly closedBlockHash: Hex;
}

export type LifecycleApiRequest =
  | { readonly kind: "enroll-account"; readonly round: string; readonly body: EnrollAccountRequest }
  | { readonly kind: "settle-round"; readonly round: string; readonly body: SettleRoundRequest }
  | {
      readonly kind: "recover-operator-gas";
      readonly round: string;
      readonly body: RecoverOperatorGasRequest;
    };

export type OperatorApiRequest =
  | { readonly kind: "health" }
  | RegisterSponsorApiRequest
  | GetRoundApiRequest
  | IssueInviteApiRequest
  | DeriveOperatorApiRequest
  | PrepareOperationApiRequest
  | SubmitOperationApiRequest
  | LifecycleApiRequest;

export interface OperatorRequestContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface OperatorHttpApi {
  execute(
    request: OperatorApiRequest,
    context: OperatorRequestContext,
  ): Promise<unknown>;
}

export interface OperatorHttpLogger {
  log(record: object): void;
}

export interface OperatorHttpOptions {
  readonly allowedOrigins: readonly string[];
  readonly api: OperatorHttpApi;
  readonly logger: OperatorHttpLogger;
  readonly maxBodyBytes?: number;
  readonly deadlineMs?: number;
  readonly requestId?: () => string;
  readonly rateLimits?: RateLimitOptions;
}

export interface RateLimitOptions {
  readonly windowMs: number;
  readonly perIp: number;
  readonly perRound: number;
  readonly perWallet: number;
}

interface RateEntry {
  readonly key: string;
  readonly maximum: number;
}

interface RateWindow {
  readonly startedAt: number;
  readonly count: number;
}

class FixedWindowLimiter {
  private readonly windows = new Map<string, RateWindow>();

  constructor(private readonly options?: RateLimitOptions) {}

  take(entries: readonly RateEntry[]): boolean {
    if (this.options === undefined) return true;
    const now = Date.now();
    const current = entries.map((entry) => ({
      entry,
      window: this.currentWindow(entry.key, now),
    }));
    if (current.some(({ entry, window }) => window.count >= entry.maximum)) {
      return false;
    }
    for (const { entry, window } of current) {
      this.windows.set(entry.key, { ...window, count: window.count + 1 });
    }
    return true;
  }

  private currentWindow(key: string, now: number): RateWindow {
    const existing = this.windows.get(key);
    if (
      existing === undefined ||
      now - existing.startedAt >= (this.options?.windowMs ?? 0)
    ) {
      return { startedAt: now, count: 0 };
    }
    return existing;
  }
}

interface RequestRuntime {
  readonly requestId: string;
  readonly ip: string;
  readonly limiter: FixedWindowLimiter;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: object,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(json(body));
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_request", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "invalid_request", `${key} must be a string`);
  }
  return value;
}

function requireExactKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const unexpected = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unexpected.length !== 0) {
    throw new HttpError(400, "invalid_request", `${name} contains unknown fields`);
  }
}

function requireAddress(object: Record<string, unknown>, key: string) {
  try {
    return getAddress(requireString(object, key));
  } catch {
    throw new HttpError(400, "invalid_request", `${key} is not an address`);
  }
}

function requireHex(
  object: Record<string, unknown>,
  key: string,
  bytes?: number,
): Hex {
  const value = requireString(object, key);
  if (!isHex(value) || (bytes !== undefined && size(value) !== bytes)) {
    throw new HttpError(400, "invalid_request", `${key} is invalid`);
  }
  return value;
}

function requireInteger(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HttpError(400, "invalid_request", `${key} must be an integer`);
  }
  return value as number;
}

function requirePositiveBigInt(
  object: Record<string, unknown>,
  key: string,
): bigint {
  const value = requireString(object, key);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new HttpError(400, "invalid_request", `${key} must be a positive integer string`);
  }
  return BigInt(value);
}

function requireBigInt(object: Record<string, unknown>, key: string): bigint {
  const value = requireString(object, key);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new HttpError(400, "invalid_request", `${key} must be an unsigned integer string`);
  }
  return BigInt(value);
}

function parseProof(value: unknown, name: string): WalletProof {
  const proof = requireObject(value, name);
  requireExactKeys(proof, ["nonce", "expiresAt", "signature"], name);
  return {
    nonce: requireString(proof, "nonce"),
    expiresAt: requireInteger(proof, "expiresAt"),
    signature: requireHex(proof, "signature", 65),
  };
}

function parseSponsorRequest(round: string, value: unknown): RegisterSponsorRequest {
  const body = requireObject(value, "body");
  requireExactKeys(
    body,
    ["sponsor", "slot", "registrationTx", "declaredBudget", "admission", "sponsorProof"],
    "body",
  );
  return {
    round,
    sponsor: requireAddress(body, "sponsor"),
    slot: requireInteger(body, "slot"),
    registrationTx: requireHex(body, "registrationTx", 32),
    declaredBudget: requirePositiveBigInt(body, "declaredBudget"),
    admission: parseProof(body.admission, "admission"),
    sponsorProof: parseProof(body.sponsorProof, "sponsorProof"),
  };
}

function parseInviteRequest(round: string, value: unknown): IssueInviteRequest {
  const body = requireObject(value, "body");
  requireExactKeys(
    body,
    ["sponsor", "slot", "owner", "inviteNonce", "inviteExpiresAt", "sponsorProof"],
    "body",
  );
  return {
    round,
    sponsor: requireAddress(body, "sponsor"),
    slot: requireInteger(body, "slot"),
    owner: requireAddress(body, "owner"),
    inviteNonce: requireString(body, "inviteNonce"),
    inviteExpiresAt: requireInteger(body, "inviteExpiresAt"),
    sponsorProof: parseProof(body.sponsorProof, "sponsorProof"),
  };
}

function parseDeriveRequest(value: unknown): DeriveOperatorApiRequest["body"] {
  const body = requireObject(value, "body");
  requireExactKeys(body, ["creator", "roundSalt"], "body");
  return {
    creator: requireAddress(body, "creator"),
    roundSalt: requireHex(body, "roundSalt", 32),
  };
}

const OPERATION_KEYS = [
  "sender", "nonce", "factory", "factoryData", "callData",
  "callGasLimit", "verificationGasLimit", "preVerificationGas",
  "maxFeePerGas", "maxPriorityFeePerGas", "paymaster",
  "paymasterVerificationGasLimit", "paymasterPostOpGasLimit",
  "paymasterData", "signature",
] as const;

function parseFactoryFields(body: Record<string, unknown>) {
  if (body.factory === undefined && body.factoryData !== undefined) {
    throw new HttpError(400, "invalid_request", "factoryData requires factory");
  }
  if (body.factory === undefined) return {};
  return {
    factory: requireAddress(body, "factory"),
    factoryData: requireHex(body, "factoryData"),
  };
}

function parseOperation(value: unknown): UserOperation<"0.7"> {
  const body = requireObject(value, "operation");
  requireExactKeys(body, OPERATION_KEYS, "operation");
  return {
    sender: requireAddress(body, "sender"),
    nonce: requireBigInt(body, "nonce"),
    ...parseFactoryFields(body),
    callData: requireHex(body, "callData"),
    callGasLimit: requireBigInt(body, "callGasLimit"),
    verificationGasLimit: requireBigInt(body, "verificationGasLimit"),
    preVerificationGas: requireBigInt(body, "preVerificationGas"),
    maxFeePerGas: requireBigInt(body, "maxFeePerGas"),
    maxPriorityFeePerGas: requireBigInt(body, "maxPriorityFeePerGas"),
    paymaster: requireAddress(body, "paymaster"),
    paymasterVerificationGasLimit: requireBigInt(body, "paymasterVerificationGasLimit"),
    paymasterPostOpGasLimit: requireBigInt(body, "paymasterPostOpGasLimit"),
    paymasterData: requireHex(body, "paymasterData"),
    signature: requireHex(body, "signature"),
  };
}

function parsePrepareRequest(round: string, value: unknown): PrepareOperationRequest {
  const body = requireObject(value, "body");
  requireExactKeys(body, ["token", "owner", "operation"], "body");
  return {
    round,
    token: requireString(body, "token"),
    owner: requireAddress(body, "owner"),
    operation: parseOperation(body.operation),
  };
}

function parseSubmitRequest(value: unknown): SubmitOperationApiRequest["body"] {
  const body = requireObject(value, "body");
  requireExactKeys(body, ["operationKey", "operation"], "body");
  return {
    operationKey: requireHex(body, "operationKey", 32),
    operation: parseOperation(body.operation),
  };
}

function parseEnrollRequest(round: string, value: unknown): EnrollAccountRequest {
  const body = requireObject(value, "body");
  requireExactKeys(body, ["token", "owner", "account", "ownerProof"], "body");
  return {
    round,
    token: requireString(body, "token"),
    owner: requireAddress(body, "owner"),
    account: requireAddress(body, "account"),
    ownerProof: parseProof(body.ownerProof, "ownerProof"),
  };
}

function parseSettleRequest(round: string, value: unknown): SettleRoundRequest {
  const body = requireObject(value, "body");
  requireExactKeys(body, ["creatorProof"], "body");
  return { round, creatorProof: parseProof(body.creatorProof, "creatorProof") };
}

function parseRecoveryRequest(
  round: string,
  value: unknown,
): RecoverOperatorGasRequest {
  const body = requireObject(value, "body");
  requireExactKeys(body, ["closedBlockHash", "creatorProof"], "body");
  return {
    round,
    closedBlockHash: requireHex(body, "closedBlockHash", 32),
    creatorProof: parseProof(body.creatorProof, "creatorProof"),
  };
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) {
      throw new HttpError(413, "payload_too_large", "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

function readRequestJson(
  options: OperatorHttpOptions,
  request: IncomingMessage,
): Promise<unknown> {
  return readJson(request, options.maxBodyBytes ?? 65_536);
}

async function callApi(
  options: OperatorHttpOptions,
  request: OperatorApiRequest,
  runtime: RequestRuntime,
): Promise<unknown> {
  requireRateLimit(options, request, runtime);
  const controller = new AbortController();
  const deadlineMs = options.deadlineMs ?? 10_000;
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new HttpError(504, "deadline_exceeded", "Request deadline exceeded"));
    }, deadlineMs);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
  });
  return Promise.race([
    options.api.execute(request, {
      requestId: runtime.requestId,
      signal: controller.signal,
    }),
    timeout,
  ]).finally(() => controller.abort());
}

function requestWallet(request: OperatorApiRequest): string | undefined {
  switch (request.kind) {
    case "derive-operator": return request.body.creator;
    case "register-sponsor": return request.body.sponsor;
    case "issue-invite": return request.body.sponsor;
    case "enroll-account": return request.body.owner;
    case "prepare-operation": return request.body.owner;
    case "submit-operation": return request.body.operation.sender;
    default: return undefined;
  }
}

function requireRateLimit(
  options: OperatorHttpOptions,
  request: OperatorApiRequest,
  runtime: RequestRuntime,
): void {
  const limits = options.rateLimits;
  if (limits === undefined) return;
  const entries: RateEntry[] = [{ key: `ip:${runtime.ip}`, maximum: limits.perIp }];
  if ("round" in request) {
    entries.push({ key: `round:${request.round}`, maximum: limits.perRound });
  }
  const wallet = requestWallet(request);
  if (wallet !== undefined) {
    entries.push({ key: `wallet:${wallet.toLowerCase()}`, maximum: limits.perWallet });
  }
  if (!runtime.limiter.take(entries)) {
    throw new HttpError(429, "rate_limited", "Request rate limit exceeded");
  }
}

function actionRound(pathname: string, action: string): string | undefined {
  const pattern = new RegExp(
    `^/v1/rounds/(0x[0-9a-fA-F]{64})/${action}$`,
  );
  return pattern.exec(pathname)?.[1]?.toLowerCase();
}

function roundFromPath(pathname: string): string | undefined {
  const match = /^\/v1\/rounds\/(0x[0-9a-fA-F]{64})$/.exec(pathname);
  return match?.[1]?.toLowerCase();
}

function answerPreflight(response: ServerResponse): void {
  response.statusCode = 204;
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-max-age", "600");
  response.end();
}

function trustOrigin(
  options: OperatorHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && !options.allowedOrigins.includes(origin)) return false;
  if (origin !== undefined) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }
  return true;
}

function loggedRound(pathname: string): string | undefined {
  return /^\/v1\/rounds\/(0x[0-9a-fA-F]{64})(?:\/|$)/
    .exec(pathname)?.[1]?.toLowerCase();
}

function loggedOperation(pathname: string): string {
  if (pathname === "/health") return "health";
  if (pathname === "/v1/operators/derive") return "derive-operator";
  if (pathname.endsWith("/user-operations/prepare")) return "prepare-operation";
  if (pathname.endsWith("/user-operations/submit")) return "submit-operation";
  if (pathname.endsWith("/operator-gas/recover")) return "recover-operator-gas";
  if (pathname.endsWith("/sponsors")) return "register-sponsor";
  if (pathname.endsWith("/invites")) return "issue-invite";
  if (pathname.endsWith("/enroll")) return "enroll-account";
  if (pathname.endsWith("/settle")) return "settle-round";
  if (roundFromPath(pathname) !== undefined) return "get-round";
  return "unknown-route";
}

function errorOutcome(error: unknown): string {
  return error instanceof HttpError ? error.code : "internal_error";
}

function logRequest(
  options: OperatorHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  startedAt: number,
  outcome: string,
): void {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    options.logger.log({
      requestId,
      operation: loggedOperation(pathname),
      round: loggedRound(pathname),
      status: response.statusCode,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome,
    });
  } catch {
    // Logging is best effort and must not take down the request path.
  }
}

interface RoundPostRoute {
  readonly suffix: string;
  readonly status: number;
  readonly parse: (round: string, value: unknown) => OperatorApiRequest;
}

function sponsorApiRequest(round: string, value: unknown): OperatorApiRequest {
  return { kind: "register-sponsor", round, body: parseSponsorRequest(round, value) };
}

function inviteApiRequest(round: string, value: unknown): OperatorApiRequest {
  return { kind: "issue-invite", round, body: parseInviteRequest(round, value) };
}

function prepareApiRequest(round: string, value: unknown): OperatorApiRequest {
  return { kind: "prepare-operation", round, body: parsePrepareRequest(round, value) };
}

function submitApiRequest(round: string, value: unknown): OperatorApiRequest {
  return { kind: "submit-operation", round, body: parseSubmitRequest(value) };
}

function enrollApiRequest(round: string, value: unknown): OperatorApiRequest {
  return { kind: "enroll-account", round, body: parseEnrollRequest(round, value) };
}

function settleApiRequest(round: string, value: unknown): OperatorApiRequest {
  return { kind: "settle-round", round, body: parseSettleRequest(round, value) };
}

function recoveryApiRequest(round: string, value: unknown): OperatorApiRequest {
  return {
    kind: "recover-operator-gas",
    round,
    body: parseRecoveryRequest(round, value),
  };
}

const ROUND_POST_ROUTES: readonly RoundPostRoute[] = [
  { suffix: "sponsors", status: 201, parse: sponsorApiRequest },
  { suffix: "invites", status: 201, parse: inviteApiRequest },
  { suffix: "user-operations/prepare", status: 201, parse: prepareApiRequest },
  { suffix: "user-operations/submit", status: 202, parse: submitApiRequest },
  { suffix: "enroll", status: 202, parse: enrollApiRequest },
  { suffix: "settle", status: 202, parse: settleApiRequest },
  { suffix: "operator-gas/recover", status: 202, parse: recoveryApiRequest },
];

async function writeApiResult(
  options: OperatorHttpOptions,
  response: ServerResponse,
  runtime: RequestRuntime,
  request: OperatorApiRequest,
  status: number,
): Promise<void> {
  const result = await callApi(options, request, runtime);
  writeJson(response, status, requireObject(result, "response"));
}

async function dispatchGet(
  options: OperatorHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RequestRuntime,
  pathname: string,
): Promise<boolean> {
  if (request.method !== "GET") return false;
  if (pathname === "/health") {
    await writeApiResult(options, response, runtime, { kind: "health" }, 200);
    return true;
  }
  const round = roundFromPath(pathname);
  if (round === undefined) return false;
  await writeApiResult(options, response, runtime, { kind: "get-round", round }, 200);
  return true;
}

async function dispatchDerive(
  options: OperatorHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RequestRuntime,
  pathname: string,
): Promise<boolean> {
  if (request.method !== "POST" || pathname !== "/v1/operators/derive") return false;
  requireJsonContent(request);
  const body = parseDeriveRequest(await readRequestJson(options, request));
  await writeApiResult(options, response, runtime, { kind: "derive-operator", body }, 200);
  return true;
}

async function dispatchRoundPost(
  options: OperatorHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RequestRuntime,
  pathname: string,
): Promise<boolean> {
  if (request.method !== "POST") return false;
  const match = ROUND_POST_ROUTES
    .map((route) => ({ route, round: actionRound(pathname, route.suffix) }))
    .find(({ round }) => round !== undefined);
  if (match?.round === undefined) return false;
  requireJsonContent(request);
  const value = await readRequestJson(options, request);
  await writeApiResult(
    options,
    response,
    runtime,
    match.route.parse(match.round, value),
    match.route.status,
  );
  return true;
}

async function dispatch(
  options: OperatorHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RequestRuntime,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "OPTIONS") {
    answerPreflight(response);
    return;
  }
  if (await dispatchGet(options, request, response, runtime, pathname)) return;
  if (await dispatchDerive(options, request, response, runtime, pathname)) return;
  if (await dispatchRoundPost(options, request, response, runtime, pathname)) return;
  throw new HttpError(404, "not_found", "Route was not found");
}

function requireJsonContent(request: IncomingMessage): void {
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
}

function writeFailure(response: ServerResponse, error: unknown): void {
  const failure = error instanceof HttpError
    ? error
    : new HttpError(500, "internal_error", "Internal service error");
  writeJson(response, failure.status, {
    error: { code: failure.code, message: failure.message },
  });
}

function rejectOrigin(
  options: OperatorHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  startedAt: number,
): boolean {
  if (trustOrigin(options, request, response)) return false;
  const error = new HttpError(403, "origin_forbidden", "Origin is not allowed");
  writeFailure(response, error);
  logRequest(options, request, response, requestId, startedAt, error.code);
  return true;
}

async function handleRequest(
  options: OperatorHttpOptions,
  limiter: FixedWindowLimiter,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestId = options.requestId?.() ?? randomUUID();
  const startedAt = Date.now();
  let outcome = "success";
  response.setHeader("x-request-id", requestId);
  if (rejectOrigin(options, request, response, requestId, startedAt)) return;
  try {
    await dispatch(options, request, response, {
      requestId,
      ip: request.socket.remoteAddress ?? "unknown",
      limiter,
    });
  } catch (error) {
    outcome = errorOutcome(error);
    writeFailure(response, error);
  } finally {
    logRequest(options, request, response, requestId, startedAt, outcome);
  }
}

export function createOperatorHttpServer(options: OperatorHttpOptions) {
  const limiter = new FixedWindowLimiter(options.rateLimits);
  return createServer((request, response) => {
    void handleRequest(options, limiter, request, response);
  });
}
