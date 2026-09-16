# Fleet Service Interface Contract

All routes are Vercel handlers in `api/fleet/*.ts`, accept JSON, return JSON, and use runtime chain, fee, and dependency values only from validated configuration/evidence. Reads are signed POST actions; no GET request carries body authentication.

## Authentication envelope

For every signed request, the route handler MUST reject unless outer request `action === auth.action`. Before signature recovery or dispatch it MUST recompute the canonical recursively key-sorted body JSON hash and require exact equality to `auth.payloadHash`. For control, outer `pause|resume|revoke|close` is the sole action discriminant and MUST equal `auth.action`; the body contains no divergent control action.

`quote` and `challenge` are unsigned; every other action includes `{ primaryWallet, nonce, issuedAt, expiresAt, action, payloadHash, signature }`. Challenge bytes are versioned ASCII fields in this order: `fleet-mission-v1|origin|chainId|primaryWallet|nonce|issuedAt|expiresAt|action|payloadHash`; origin/address are normalized, signature is EIP-191 `personal_sign`, and payload hash is keccak of recursively key-sorted JSON UTF-8. The server returns configured max TTL in challenge response; nonce is single-use. Reuse, expiry, wrong domain, or changed payload returns `401 challenge_invalid`. `Idempotency-Key` is `fleet-[A-Za-z0-9_-]{16,128}`, required for create/confirmRecovery/fund/activate/buy/pause/resume/revoke/close, scoped to wallet/action/campaign and retained for campaign lifetime; same payload returns original result, changed payload returns `409 idempotency_conflict`. It is header-only and never appears in JSON request unions.

### Order token (trade polls)

A signed `order` is the trader's authorization for every slice it plans. When the service holds a nonce secret, the `order` response carries `orderToken`: `<issuedAtMs>.<hex HMAC-SHA256 over fleet-order-v1|origin|orderId|owner|issuedAtMs>`. A `trade` request MAY carry `orderToken` at the top level in place of `auth`; no other action accepts it. The token authorizes only the order whose `id` and `owner` it was issued for, and only for 90 minutes (the longest order window plus one hour) from issue. The route still recomputes the order id from its fields, requires the order's owner to own the campaign, runs only slices that are due and still pending, and claims each slice once, so a replayed poll buys nothing twice. A missing, forged, foreign, or expired token returns `401 challenge_invalid` before any slice is claimed; the browser then signs the poll as above. Without a nonce secret no token is issued and every poll is signed.

## Route matrix

| Route and method | Action | Request | Success | Errors |
|---|---|---|---|---|
| `POST /api/fleet/campaign` | quote/challenge/create/confirmRecovery/fund/activate/read | action discriminant plus matching payload | quote, challenge, campaign, or signed read result | `400`, `401`, `403`, `409`, `422`, `503` |
| `POST /api/fleet/buy` | buy | envelope, campaign handle, account requests | per-account results/budget receipt | `401`, `403 policy_rejected`, `409`, `422 budget_exceeded` |
| `POST /api/fleet/control` | pause/resume/revoke/close | envelope, campaign handle, control action | state/budget result | `401`, `403 revoked_terminal`, `409 state_invalid` |

## Accounting and privacy

Quote fields are configuration-derived exact integers: `netFee = baseFee - discount`, rejected when negative. Fee charge is a separate typed record `{ quoteId, feeAsset, recipient, baseFee, discount, netFee, chargeEvidence }`; asset/recipient are validated configuration, never invented constants. A successful idempotent charge records evidence once and is never debited from campaign ETH sponsorship budget. The campaign budget record reserves before paymaster submission, commits only a permitted result, rolls back failed/expired reservation idempotently, and reconciles only against that campaign's deposited ETH.

Only the service's separate operator-encrypted primary-to-fleet mapping is retained by the operator. The downloaded `RecoveryVaultEnvelope` never enters an API request; create receives only `recoveryVaultCommitment` plus public account initialization. API responses/logs omit plaintext owner credentials, recovery ciphertext, primary-to-fleet edges, raw signatures, and reusable public campaign IDs. Public activity remains accounts, trades, amounts, timing, gas, and shared paymaster.

## Wire types and status map

```ts
type Address = `0x${string}`;
type Hex = `0x${string}`;
type Uint = string;
type CampaignState = "Draft" | "Awaiting recovery confirmation" | "Awaiting funding" | "Activating" | "Active" | "Paused" | "Revoked" | "Depleted" | "Expired" | "Closed";
type Policy = { chainId: number; accounts: number; router: Address; function: string; maxTradeValue: Uint; perAccountGas: Uint; totalGas: Uint; expiry: string };
type AuthEnvelope = { primaryWallet: Address; nonce: string; issuedAt: string; expiresAt: string; action: string; payloadHash: Hex; signature: Hex };
type QuoteInput = { primaryWallet: Address };
type ChallengeInput = { primaryWallet: Address; action: string; payloadHash: Hex };
type Challenge = { nonce: string; issuedAt: string; challenge: string; expiresAt: string; maxTtlSeconds: number };
type FleetAccountInit = { ownerAddress: Address; salt: Hex };
type RecoveryVaultCommitment = Hex;
type CampaignInput = { campaign: string };
type CreateCampaignInput = { quoteId: string; policy: Policy; accounts: FleetAccountInit[]; recoveryVaultCommitment: RecoveryVaultCommitment };
type RecoveryInput = CampaignInput & { vaultConfirmed: true };
type FundInput = CampaignInput & { fundingReference: string };
type BuyInput = CampaignInput & { accounts: Address[]; token: Address; value: Uint };
type ControlInput = CampaignInput;
type SignedAction<A extends string, T> = { action: A; auth: AuthEnvelope; body: T };
type FeeQuote = { quoteId: string; threshold: Uint; baseFee: Uint; discount: Uint; netFee: Uint; eligible: boolean };
type FeeCharge = FeeQuote & { feeAsset: string; recipient: string; chargeEvidence: string };
type Budget = { funded: Uint; reserved: Uint; spent: Uint; unused: Uint };
type AccountResult = { account: Address; status: "sponsored" | "rejected"; budget: Budget };
type CampaignResult = { campaign: string; state: CampaignState; fee?: FeeCharge; budget: Budget };
type ActivationResult = CampaignResult & { accounts: Address[] };
type BuyResult = { results: AccountResult[] };
type ControlRoomResult = CampaignResult & { results: AccountResult[] };
type ApiErrorCode = "challenge_invalid" | "ineligible" | "policy_rejected" | "budget_exceeded" | "state_invalid" | "revoked_terminal" | "idempotency_conflict" | "dependency_evidence_invalid";
type ApiError = { code: ApiErrorCode; retryable: boolean };
type CampaignRequest =
  | { action: "quote"; body: QuoteInput }
  | { action: "challenge"; body: ChallengeInput }
  | SignedAction<"create", CreateCampaignInput>
  | SignedAction<"confirmRecovery", RecoveryInput>
  | SignedAction<"fund", FundInput>
  | SignedAction<"activate", CampaignInput>
  | SignedAction<"read", CampaignInput>;
type BuyRequest = SignedAction<"buy", BuyInput>;
type ControlAction = "pause" | "resume" | "revoke" | "close";
type ControlRequest = SignedAction<ControlAction, ControlInput>;
```

| Action | Success | Error |
|---|---|---|
| quote/challenge | 200 | 400, 503 / 400, 429 |
| create/confirmRecovery/fund/activate/read | 201/200/200/200/200 | 401, 403, 409, 422, 503 as applicable |
| buy/pause/resume/revoke/close | 200 | 401, 403, 409, 422 |
