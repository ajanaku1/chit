/**
 * Fleet setup wizard.
 *
 * One question per screen. Everything real happens client-side: fleet keys are
 * generated in this browser, the recovery backup is encrypted with the
 * connected wallet's signature, and confirmation re-decrypts it end to end.
 * Service-backed steps call the Fleet API and show an honest testnet-pending
 * banner whenever the hosted service cannot answer.
 *
 * Retail rules: ETH units only (wei stays internal), expert fields live behind
 * the Advanced disclosure with verified presets, and no hex is shown unless the
 * user asks for it.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  CampaignSetup,
  type GeneratedAccount,
  type SetupDeps,
  type SetupQuote,
} from "./fleet/campaign-setup.js";
import { DRAW_CAP, drawShare, fundingProgress, fundingWait, launchState, pollDelayMs } from "./fleet/balance.js";
import { banner, connectWallet, fleetApi, getConnectedWallet, initHeaderWallet, initShell, parseEth, saveFleetSnapshot, toEth, walletProvider } from "./fleet/page-shared.js";
import { invalidateBalance, readBalance } from "./fleet/balance-read.js";
import { forgetSignedReads } from "./fleet/signed-read.js";
import { prefersReducedMotion } from "./fleet/motion.js";
import { readStatus } from "./fleet/status-read.js";
import { signedFleetApi } from "./fleet/signed-request.js";
import { confirmRecovery, createRecoveryVault, type VaultContext } from "./fleet/vault.js";

type Hex = `0x${string}`;

const FLEET_CHAIN_ID = "46630";
const STEPS = ["welcome", "connect", "size", "backup", "launch", "done"] as const;
type Step = (typeof STEPS)[number];

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node as T;
};

class FleetWizard {
  #wallet: Hex | undefined;
  #setup: CampaignSetup | undefined;
  #accounts: GeneratedAccount[] = [];
  #campaign: string | undefined;
  #budgetWei = "0";
  #step: Step = "welcome";
  #history: Step[] = [];

  start(): void {
    // A trader with a remembered wallet has nothing to connect; skip the step.
    el("start").addEventListener("click", () => this.#go(this.#wallet ? "size" : "connect"));
    el("connect-wallet").addEventListener("click", () => void this.#connect());
    // Connecting from the header counts too; without this the wizard would sit
    // on step one beside a header that says the wallet is connected.
    window.addEventListener("chit-wallet-changed", () => {
      const address = getConnectedWallet();
      if (address && address !== this.#wallet) void this.#adopt(address);
      else if (!address) this.#wallet = undefined;
    });
    el("a-draw").addEventListener("input", () => this.#renderLaunch());
    el("size-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#configure();
    });
    el("generate-vault").addEventListener("click", () => void this.#generateVault());
    el("confirm-vault").addEventListener("click", () => void this.#confirm());
    el("to-launch").addEventListener("click", () => this.#go("launch"));
    el("launch-fleet").addEventListener("click", () => void this.#launch());
    for (const back of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-back]"))) {
      back.addEventListener("click", () => this.#back());
    }
    this.#bindQuickpicks();

    // A wallet remembered from an earlier load fires no connect event, so it
    // is taken up here; the event handler above covers wallets that arrive later.
    const remembered = getConnectedWallet();
    if (remembered) void this.#adopt(remembered, false);
  }

  /** Preset pills mirror into their input; the input stays the source of truth. */
  #bindQuickpicks(): void {
    for (const pill of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-pick]"))) {
      pill.addEventListener("click", () => {
        const input = document.getElementById(pill.dataset["pick"] ?? "") as HTMLInputElement | HTMLSelectElement | null;
        if (!input) return;
        input.value = pill.dataset["value"] ?? input.value;
        for (const sibling of Array.from(
          document.querySelectorAll<HTMLButtonElement>(`[data-pick="${pill.dataset["pick"]}"]`),
        )) {
          sibling.setAttribute("aria-pressed", String(sibling === pill));
        }
      });
    }
  }

  #go(step: Step): void {
    this.#history.push(this.#step);
    this.#show(step);
    // Arriving at launch, the button must already say whether it can be used.
    if (step === "launch") this.#renderLaunch();
  }

  #back(): void {
    const previous = this.#history.pop();
    if (previous) this.#show(previous);
  }

  #show(step: Step): void {
    el("wizard").dataset["dir"] = STEPS.indexOf(step) < STEPS.indexOf(this.#step) ? "back" : "forward";
    this.#step = step;
    for (const section of Array.from(document.querySelectorAll<HTMLElement>("[data-wstep]"))) {
      section.hidden = section.dataset["wstep"] !== step;
    }
    for (const dot of Array.from(document.querySelectorAll<HTMLElement>("[data-dot]"))) {
      const index = STEPS.indexOf(dot.dataset["dot"] as Step);
      const current = STEPS.indexOf(step);
      dot.removeAttribute("aria-current");
      dot.dataset["done"] = String(index < current);
      if (index === current) dot.setAttribute("aria-current", "step");
    }
    el("status-banner").hidden = true;
    window.scrollTo({ top: 0 });
  }

  #signMessage = async (message: string): Promise<Hex> => {
    const eth = walletProvider();
    if (!eth || !this.#wallet) throw new Error("wallet_unavailable");
    return (await eth.request({ method: "personal_sign", params: [message, this.#wallet] })) as Hex;
  };

  #vaultContext(): VaultContext {
    if (!this.#wallet) throw new Error("wallet_unavailable");
    return {
      origin: window.location.origin,
      primaryChainId: FLEET_CHAIN_ID,
      primaryWallet: this.#wallet,
      signMessage: this.#signMessage,
    };
  }

  #deps(): SetupDeps {
    return {
      fetchQuote: async (wallet) => this.#fetchQuote(wallet),
      generateAccounts: async (count) => this.#generateAccounts(count),
      createVault: (accounts) => createRecoveryVault(this.#vaultContext(), accounts),
      confirmVault: (envelopeJson, commitment) => confirmRecovery(this.#vaultContext(), envelopeJson, commitment),
      submit: async (action, body) => {
        if (!this.#wallet) throw new Error("not_connected");
        const result = await signedFleetApi(this.#wallet, action, body);
        this.#lastResult = result;
        return {
          campaign: String(result["campaign"] ?? this.#campaign ?? "preview"),
          state: String(result["state"] ?? "Awaiting recovery confirmation"),
        };
      },
    };
  }

  /** The most recent service response, so the launch step can read its draw. */
  #lastResult: Record<string, unknown> = {};

  /** The trader's spendable Chit balance, read when the wallet connects. */
  #availableBalance = "0";

  /**
   * Takes up a wallet the header already connected. Calling connectWallet again
   * here would ask the wallet a second time for something it has just granted.
   */
  async #adopt(address: Hex, advance = true): Promise<void> {
    this.#wallet = address;
    this.#setup ??= new CampaignSetup(this.#deps());
    this.#availableBalance = await this.#fetchBalance(address);
    this.#renderLaunch();

    const walletLine = el("wallet-line");
    walletLine.textContent =
      `Connected: ${address.slice(0, 6)}…${address.slice(-4)} · Robinhood testnet` +
      ` · balance ${toEth(this.#availableBalance)} ETH`;
    walletLine.hidden = false;

    await this.#setup.connect(address);
    // Only move the trader on if they are waiting on this step; adopting a
    // wallet from the header must not yank them out of a later one.
    if (advance && (this.#step === "connect" || this.#step === "welcome")) this.#go("size");
  }

  /** Keeps the launch button and its note telling the same story. */
  #renderLaunch(): void {
    const input = document.getElementById("a-draw") as HTMLInputElement | null;
    const button = document.getElementById("launch-fleet") as HTMLButtonElement | null;
    const note = document.getElementById("draw-note");
    if (!input || !button || !note) return;
    const drawWei = parseEth(input.value);
    const state = launchState(drawWei, this.#availableBalance);
    button.disabled = state.disabled;
    note.textContent = state.note;
    const share = drawShare(drawWei);
    el("draw-fill").style.setProperty("--fill", String(share));
    el("draw-meter").setAttribute("aria-valuenow", String(share));
    el("draw-meter").setAttribute("aria-valuetext", `${Math.round(share * 100)}% of the ${toEth(DRAW_CAP)} ETH cap`);
  }

  /**
   * The needle turns in real time through the wait, using a transform-only
   * transition that runs until the due time. Under reduced motion it just
   * sits at the current point.
   */
  #showFunding(dueAt: string | undefined): void {
    const gauge = el("funding-gauge");
    gauge.hidden = dueAt === undefined;
    if (!dueAt) return;
    const needle = el("funding-needle");
    const now = new Date();
    needle.style.transition = "none";
    needle.style.setProperty("--p", String(fundingProgress(dueAt, now)));
    if (prefersReducedMotion()) return;
    const remaining = Math.max(0, Date.parse(dueAt) - now.getTime());
    void needle.getBoundingClientRect();
    needle.style.transition = `transform ${remaining}ms linear`;
    needle.style.setProperty("--p", "1");
  }

  async #connect(): Promise<void> {
    // Already taken up: the step has nothing left to ask for.
    if (this.#wallet) {
      this.#go("size");
      return;
    }
    try {
      const address = (await connectWallet()) ?? getConnectedWallet();
      if (!address) {
        banner("Connect your wallet and approve the switch to Robinhood testnet to continue.", "pending");
        return;
      }
      // One route in, whether the wallet came from this button or the header.
      await this.#adopt(address);
    } catch (error) {
      banner(`Couldn't connect: ${(error as Error).message}`, "error");
    }
  }

  async #fetchQuote(wallet: Hex): Promise<SetupQuote> {
    const { status, body } = await fleetApi("quote", { action: "quote", body: { primaryWallet: wallet } });
    const line = el("eligibility-line");
    if (status === 200 && typeof body["netFee"] === "string") {
      const eligible = body["eligible"] === true;
      line.textContent = eligible
        ? `You're in — service fee ${toEth(String(body["netFee"]))} ETH after your CHIT discount.`
        : "This wallet doesn't hold enough CHIT yet.";
      line.hidden = false;
      return body as unknown as SetupQuote;
    }
    line.textContent = "Eligibility preview — the live check arrives with the testnet service.";
    line.hidden = false;
    return { quoteId: "preview", threshold: "0", baseFee: "0", discount: "0", netFee: "0", eligible: true };
  }

  async #generateAccounts(count: number): Promise<GeneratedAccount[]> {
    const accounts: GeneratedAccount[] = [];
    for (let index = 0; index < count; index += 1) {
      const privateKey = generatePrivateKey();
      const salt = new Uint8Array(32);
      crypto.getRandomValues(salt);
      accounts.push({
        ownerAddress: privateKeyToAccount(privateKey).address.toLowerCase() as Hex,
        privateKey,
        salt: `0x${[...salt].map((byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex,
      });
    }
    this.#accounts = accounts;
    return accounts;
  }

  async #configure(): Promise<void> {
    if (!this.#setup) return;
    const data = new FormData(el<HTMLFormElement>("size-form"));
    const errorLine = el("size-error");
    try {
      const wallets = Number(data.get("wallets") ?? 0);
      const days = Number(data.get("duration") ?? 7);
      const perGasWei = parseEth(String(data.get("perGas") ?? "0.0002"));
      this.#budgetWei = parseEth(String(data.get("budget") ?? "0"));

      await this.#setup.configure({
        name: "my-fleet",
        chainId: Number(FLEET_CHAIN_ID),
        accounts: wallets,
        router: String(data.get("router") ?? "") as Hex,
        function: String(data.get("function") ?? ""),
        maxTradeValue: parseEth(String(data.get("maxTrade") ?? "0.0005")),
        perAccountGas: perGasWei,
        // The total follows the fleet size; nobody should compute wei by hand.
        totalGas: (BigInt(perGasWei) * BigInt(wallets)).toString(),
        expiry: new Date(Date.now() + days * 86_400_000).toISOString(),
      });
      errorLine.hidden = true;
      this.#go("backup");
    } catch (error) {
      errorLine.textContent = this.#humanize((error as { reason?: string }).reason ?? (error as Error).message);
      errorLine.hidden = false;
    }
  }

  #humanize(reason: string): string {
    const messages: Record<string, string> = {
      invalid_account_count: "Pick between 5 and 50 wallets.",
      invalid_totalGas: "The gas budget must be more than zero.",
      invalid_perAccountGas: "The per-wallet gas cap must be more than zero.",
      invalid_maxTradeValue: "The max trade must be more than zero.",
      invalid_expiry: "Pick a duration in the future.",
      invalid_router: "The router address in Advanced settings looks wrong.",
      invalid_eth_amount: "Enter an amount like 0.001.",
      ineligible: "This wallet doesn't hold enough CHIT yet.",
    };
    return messages[reason] ?? `Something needs a second look: ${reason}`;
  }

  async #generateVault(): Promise<void> {
    if (!this.#setup) return;
    try {
      const vault = await this.#setup.downloadVault();
      this.#downloadFile("chit-fleet-backup.json", vault.envelopeJson);
      const line = el("vault-line");
      line.textContent = "Backup downloaded.";
      line.hidden = false;
      el("vault-warn").hidden = false;
      (el("confirm-vault") as HTMLButtonElement).disabled = false;
    } catch (error) {
      banner(`Couldn't create the backup: ${(error as Error).message}`, "error");
      return;
    }
    try {
      await this.#setup.create();
    } catch (error) {
      this.#pendingOrError("create", error);
    }
  }

  async #confirm(): Promise<void> {
    if (!this.#setup) return;
    try {
      await this.#setup.confirmRecovery();
      const line = el("confirm-line");
      line.textContent = "Verified — your backup opens.";
      line.hidden = false;
      (el("to-launch") as HTMLButtonElement).disabled = false;
      banner("Backup verified. Your keys never left this browser.", "ok");
    } catch (error) {
      banner("That signature didn't open the backup. Same wallet as step 1?", "error");
    }
  }

  async #launch(): Promise<void> {
    if (!this.#setup) return;
    this.#renderSummary();
    const draw = parseEth((el("a-draw") as HTMLInputElement).value);
    const state = launchState(draw, this.#availableBalance);
    if (state.disabled) {
      this.#renderLaunch();
      banner(state.note, "pending");
      return;
    }
    try {
      const activated = await this.#setup.activate(draw);
      if (this.#wallet) invalidateBalance(this.#wallet);
      this.#campaign = activated.campaign;
      const dueAt = (this.#lastResult["draw"] as { dueAt?: string } | undefined)?.dueAt;
      if (dueAt) el("funding-wait").textContent = fundingWait(dueAt, new Date()).message;
      this.#showFunding(dueAt);
      this.#awaitFunding(activated.state, dueAt);
      saveFleetSnapshot({
        campaign: this.#campaign,
        state: "Active",
        budget: { funded: draw, reserved: "0", spent: "0", unused: draw },
        accounts: this.#accounts.map((account) => account.ownerAddress),
      });
      this.#go("done");
    } catch (error) {
      this.#pendingOrError("launch", error);
      // The client-side journey is complete either way; let the user reach the
      // dashboard, which shows the same honest pending state.
      saveFleetSnapshot({
        campaign: this.#campaign ?? "preview",
        state: "Pending service",
        budget: { funded: "0", reserved: "0", spent: "0", unused: "0" },
        accounts: this.#accounts.map((account) => account.ownerAddress),
      });
      this.#go("done");
    } finally {
      // A launch that failed part way may still have created the fleet.
      if (this.#wallet) forgetSignedReads(this.#wallet);
    }
  }

  /**
   * Keeps asking until the fleet is funded. Each ask sweeps on the service side,
   * so the trader's open page is what completes their own activation.
   */
  #awaitFunding(state: string, dueAt: string | undefined): void {
    const delay = pollDelayMs(state, dueAt, new Date());
    if (delay === undefined || !this.#wallet || !this.#campaign) return;
    globalThis.setTimeout(() => {
      void (async () => {
        try {
          const body = await readStatus(this.#campaign!);
          const next = body.state;
          const nextDue = body.draw?.dueAt;
          if (next === "Activating") {
            if (nextDue) el("funding-wait").textContent = fundingWait(nextDue, new Date()).message;
            this.#showFunding(nextDue);
          } else {
            el("funding-wait").textContent = "Your fleet is funded and live.";
            this.#showFunding(undefined);
          }
          this.#awaitFunding(next, nextDue);
        } catch {
          this.#awaitFunding(state, dueAt);
        }
      })();
    }, delay);
  }

  /** The spendable balance, or zero while the pool is not configured yet. */
  async #fetchBalance(wallet: Hex): Promise<string> {
    try {
      return String((await readBalance(wallet)).available ?? "0");
    } catch {
      return "0";
    }
  }

  #renderSummary(): void {
    const summary = el("launch-summary");
    summary.innerHTML = "";
    const rows: [string, string][] = [
      ["Wallets", String(this.#accounts.length)],
      ["Gas budget", `${toEth(this.#budgetWei)} ETH`],
    ];
    for (const [term, value] of rows) {
      const wrap = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      wrap.append(dt, dd);
      summary.appendChild(wrap);
    }
  }

  #pendingOrError(action: string, error: unknown): void {
    const code = (error as { reason?: string; message: string }).reason ?? (error as Error).message;
    if (code.startsWith("dependency_evidence") || code.startsWith("status_503") || code === "not_created") {
      banner(
        "The testnet service isn't deployed yet, so this step is queued rather than live. Your fleet and backup are real and stay on your side.",
        "pending",
      );
    } else {
      banner(`${action} didn't go through: ${this.#humanize(code)}`, "error");
    }
  }

  #downloadFile(name: string, contents: string): void {
    const blob = new Blob([contents], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

initHeaderWallet();
initShell();
new FleetWizard().start();
