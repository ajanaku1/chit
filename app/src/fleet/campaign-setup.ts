/**
 * Campaign setup journey (FR-001, FR-003 to FR-006, SC-001).
 *
 * The guided path from eligible connect to activation, kept DOM-free so the
 * page wiring stays thin. Order is enforced here: fee disclosure before
 * anything is created, the encrypted recovery vault downloaded AND confirmed by
 * a fresh signature round-trip before funding or activation, and one generated
 * fleet per journey no matter how many times a step is retried.
 */

import { assertServiceSafe } from "./index.js";

type Hex = `0x${string}`;

export type SetupQuote = {
  quoteId: string;
  threshold: string;
  baseFee: string;
  discount: string;
  netFee: string;
  eligible: boolean;
};

export type PolicyForm = {
  name: string;
  chainId: number;
  accounts: number;
  router: Hex;
  function: string;
  maxTradeValue: string;
  perAccountGas: string;
  totalGas: string;
  expiry: string;
};

export type GeneratedAccount = { ownerAddress: Hex; privateKey: Hex; salt: Hex };

export type SetupDeps = {
  fetchQuote: (wallet: Hex) => Promise<SetupQuote>;
  generateAccounts: (count: number) => Promise<GeneratedAccount[]>;
  createVault: (accounts: GeneratedAccount[]) => Promise<{ envelopeJson: string; commitment: Hex }>;
  confirmVault: (envelopeJson: string, commitment: Hex) => Promise<true>;
  submit: (action: string, body: Record<string, unknown>) => Promise<{ campaign: string; state: string }>;
};

export class SetupError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`setup_blocked: ${reason}`);
    this.name = "SetupError";
    this.reason = reason;
  }
}

const blocked = (reason: string): never => {
  throw new SetupError(reason);
};

const UINT = /^(0|[1-9][0-9]*)$/;

export class CampaignSetup {
  readonly #deps: SetupDeps;
  #quote: SetupQuote | undefined;
  #policy: PolicyForm | undefined;
  #accounts: GeneratedAccount[] | undefined;
  #vault: { envelopeJson: string; commitment: Hex } | undefined;
  #vaultConfirmed = false;
  #campaign: string | undefined;

  constructor(deps: SetupDeps) {
    this.#deps = deps;
  }

  /** Step 1: connect and disclose the fee facts before anything exists. */
  async connect(wallet: Hex): Promise<SetupQuote> {
    this.#quote = await this.#deps.fetchQuote(wallet);
    return this.#quote;
  }

  /** Step 2: validate the bounded policy. Nothing is generated for a bad form. */
  async configure(form: PolicyForm): Promise<PolicyForm> {
    const quote = this.#quote ?? blocked("not_connected");
    if (!quote.eligible) blocked("ineligible");
    if (form.name.trim().length === 0) blocked("invalid_name");
    if (!Number.isSafeInteger(form.accounts) || form.accounts < 5 || form.accounts > 50) blocked("invalid_account_count");
    if (!/^0x[0-9a-fA-F]{40}$/.test(form.router)) blocked("invalid_router");
    if (form.function.length === 0) blocked("invalid_function");
    for (const field of ["maxTradeValue", "perAccountGas", "totalGas"] as const) {
      if (!UINT.test(form[field]) || form[field] === "0") blocked(`invalid_${field}`);
    }
    if (Number.isNaN(Date.parse(form.expiry)) || Date.parse(form.expiry) <= Date.now()) blocked("invalid_expiry");
    this.#policy = form;
    return form;
  }

  /** One fleet per journey: a retry reuses what was already generated (FR-014). */
  async #ensureAccounts(): Promise<GeneratedAccount[]> {
    const policy = this.#policy ?? blocked("not_configured");
    this.#accounts ??= await this.#deps.generateAccounts(policy.accounts);
    return this.#accounts;
  }

  /** Step 3: download the encrypted recovery vault. */
  async downloadVault(): Promise<{ envelopeJson: string; commitment: Hex }> {
    this.#vault ??= await this.#deps.createVault(await this.#ensureAccounts());
    return this.#vault;
  }

  /** Step 4: create the campaign. Only public data crosses the boundary. */
  async create(): Promise<{ campaign: string; state: string }> {
    const policy = this.#policy ?? blocked("not_configured");
    const accounts = await this.#ensureAccounts();
    const vault = await this.downloadVault();
    if (this.#campaign) return { campaign: this.#campaign, state: "Awaiting recovery confirmation" };

    const body = {
      quoteId: (this.#quote ?? blocked("not_connected")).quoteId,
      policy: {
        chainId: policy.chainId,
        accounts: policy.accounts,
        router: policy.router,
        function: policy.function,
        maxTradeValue: policy.maxTradeValue,
        perAccountGas: policy.perAccountGas,
        totalGas: policy.totalGas,
        expiry: policy.expiry,
      },
      accounts: accounts.map((account) => ({ ownerAddress: account.ownerAddress, salt: account.salt })),
      recoveryVaultCommitment: vault.commitment,
    };
    assertServiceSafe(body);
    const created = await this.#deps.submit("create", body);
    this.#campaign = created.campaign;
    return created;
  }

  /** Step 5: fresh second signature + decrypt round-trip (FR-006). */
  async confirmRecovery(): Promise<void> {
    const vault = this.#vault ?? blocked("vault_not_downloaded");
    await this.#deps.confirmVault(vault.envelopeJson, vault.commitment);
    this.#vaultConfirmed = true;
    if (this.#campaign) {
      await this.#deps.submit("confirmRecovery", { campaign: this.#campaign, vaultConfirmed: true });
    }
  }

  #requireConfirmed(): string {
    if (!this.#vaultConfirmed) blocked("vault_not_confirmed");
    return this.#campaign ?? blocked("not_created");
  }

  /** Steps 6 and 7 are blocked until the vault is confirmed. */
  async fund(fundingReference: string): Promise<{ campaign: string; state: string }> {
    const campaign = this.#requireConfirmed();
    return this.#deps.submit("fund", { campaign, fundingReference });
  }

  async activate(): Promise<{ campaign: string; state: string }> {
    const campaign = this.#requireConfirmed();
    return this.#deps.submit("activate", { campaign });
  }
}
