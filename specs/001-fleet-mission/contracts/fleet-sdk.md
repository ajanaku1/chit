# Fleet SDK Interface Contract

```ts
type Address = `0x${string}`; type Hex = `0x${string}`; type Uint = string;
type AuthEnvelope = { primaryWallet: Address; nonce: string; issuedAt: string; expiresAt: string; action: string; payloadHash: Hex; signature: Hex };
type QuoteInput = { primaryWallet: Address }; type ChallengeInput = { primaryWallet: Address; action: string; payloadHash: Hex }; type CampaignInput = { campaign: string };
type CreateCampaignInput = { quoteId: string; policy: Policy; accounts: FleetAccountInit[]; recoveryVaultCommitment: Hex }; type RecoveryInput = CampaignInput & { vaultConfirmed: true }; type FundInput = CampaignInput & { fundingReference: string }; type BuyInput = CampaignInput & { accounts: Address[]; token: Address; value: Uint }; type ControlInput = CampaignInput;
type Signed<T> = { auth: AuthEnvelope; body: T }; type Idempotent<T> = { auth: AuthEnvelope; idempotencyKey: string; body: T }; type ControlAction = "pause"|"resume"|"revoke"|"close"; type Policy = { chainId: number; accounts: number; router: Address; function: string; maxTradeValue: Uint; perAccountGas: Uint; totalGas: Uint; expiry: string }; type FleetAccountInit = { ownerAddress: Address; salt: Hex };
type FleetClient = { quote(input: QuoteInput): Promise<FeeQuote>; challenge(input: ChallengeInput): Promise<Challenge>; createCampaign(input: Idempotent<CreateCampaignInput>): Promise<CampaignResult>; confirmRecovery(input: Idempotent<RecoveryInput>): Promise<CampaignResult>; fund(input: Idempotent<FundInput>): Promise<CampaignResult>; activate(input: Idempotent<CampaignInput>): Promise<ActivationResult>; buy(input: Idempotent<BuyInput>): Promise<BuyResult>; control(action: ControlAction, input: Idempotent<CampaignInput>): Promise<CampaignResult>; readCampaign(input: Signed<CampaignInput>): Promise<ControlRoomResult>; };
```

Quote/challenge/read are non-idempotent; all other methods require the API-format key. `recoveryVaultCommitment` is keccak256 of the canonical complete local envelope bytes; the SDK never serializes the envelope or owner private keys. Response/result/error shapes are declared in `fleet-api.md`; rejected requests consume neither fee nor campaign ETH.

`idempotencyKey` is client metadata serialized ONLY as HTTP `Idempotency-Key`; it MUST NOT appear in JSON. JSON is `{ action, auth, body }`. Before sending every signed action, the SDK sets and compares outer `action` with `auth.action`; for `control`, the method argument is the only outer action and must equal `input.auth.action`.
