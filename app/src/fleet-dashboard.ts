/**
 * Fleet dashboard: watch the budget, pause/resume/stop/close, run the buy.
 * Reads the public snapshot the wizard saved; without one it points the user
 * back to setup. Lifecycle buttons offer only what the current state legally
 * allows, straight from the tested control-room view.
 */

import { buildControlRoomView, confirmationFor, isLiveState, type CampaignState, type ControlAction } from "./fleet/control-room.js";
import { askBeforeSigning, banner, clearFleetSnapshot, confirmDialog, dropSigningAsk, getConnectedWallet, initHeaderWallet, initShell, loadFleetSnapshot, parseEth, saveFleetSnapshot, toEth, type FleetSnapshot } from "./fleet/page-shared.js";
import { invalidateBalance, readBalance, recentBalance } from "./fleet/balance-read.js";
import { forgetSignedReads, readSigned, recentSigned } from "./fleet/signed-read.js";
import { StatusUnavailable, readStatus } from "./fleet/status-read.js";
import { RequestFailed, signedFleetApi } from "./fleet/signed-request.js";
import type { DrawView } from "./fleet/control-room.js";
import { capShare, pollDelayMs, stateLabel, type CachedBalance } from "./fleet/balance.js";
import { renderLed } from "./fleet/led.js";

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node as T;
};

const KNOWN_STATES: readonly CampaignState[] = [
  "Draft", "Awaiting recovery confirmation", "Awaiting funding", "Activating",
  "Active", "Paused", "Revoked", "Depleted", "Expired", "Closed",
];

class FleetDashboard {
  #snapshot: FleetSnapshot;
  /** Live pool facts, refreshed from the service; absent before it answers. */
  #draw: DrawView | undefined;
  #available = "0";
  /** False until a balance is read: the strip shows a dash, not a zero nobody measured. */
  #availableKnown = false;
  #poolPaused = false;

  constructor(snapshot: FleetSnapshot) {
    this.#snapshot = snapshot;
  }

  start(): void {
    el("no-fleet").hidden = true;
    el("fleet-view").hidden = false;
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-action]"))) {
      button.addEventListener("click", () => void this.#control(button.dataset["action"] as ControlAction));
    }
    // The header owns the wallet button; follow it rather than bind it again.
    window.addEventListener("chit-wallet-changed", () => void this.#refresh());
    void this.#refresh();
    this.#render();
  }

  #state(): CampaignState | undefined {
    return (KNOWN_STATES as readonly string[]).includes(this.#snapshot.state)
      ? (this.#snapshot.state as CampaignState)
      : undefined;
  }

  #render(): void {
    const chip = el("state-chip");
    chip.textContent = stateLabel(this.#snapshot.state);
    chip.dataset["live"] = String(isLiveState(this.#snapshot.state));
    chip.dataset["state"] = this.#snapshot.state;

    const state = this.#state();
    if (!state) {
      // "Pending service": the wizard finished locally but the testnet service
      // isn't live. Show the truth and disable everything but setup.
      el("state-note").textContent =
        "Your fleet and backup are ready on your side. Launch completes once the testnet service is deployed.";
      this.#renderAccounts();
      return;
    }

    const view = buildControlRoomView({
      campaign: this.#snapshot.campaign,
      state,
      budget: this.#snapshot.budget,
      ...(this.#draw ? { draw: this.#draw, balance: { available: this.#available }, pool: { paused: this.#poolPaused } } : {}),
    });
    const strip = el("balance-strip");
    strip.hidden = this.#draw === undefined;
    if (this.#draw) {
      renderLed(el("bal-available"), this.#availableKnown ? toEth(this.#available) : "—", "ETH");
      renderLed(el("draw-amount"), toEth(this.#draw.amount), "ETH");
      renderLed(el("draw-spent"), toEth(this.#draw.spent), "ETH");
      renderLed(el("draw-remaining"), toEth(this.#draw.remaining), "ETH");
      const used = capShare(this.#draw.remaining, this.#draw.amount);
      el("draw-used-fill").style.setProperty("--fill", String(used));
      el("draw-used-meter").setAttribute("aria-valuenow", String(used));
      el("draw-used-meter").setAttribute("aria-valuetext", `${Math.round(used * 100)}% of this fleet's draw spent`);
    }
    const poolBanner = el("pool-paused");
    poolBanner.hidden = !view.poolPaused;
    poolBanner.textContent = view.poolNote ?? "";
    el("state-note").textContent = view.stateNote;
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-action]"))) {
      button.disabled = !view.availableActions.includes(button.dataset["action"] as ControlAction);
    }
    // Trading lives on the Trade page; the link only makes sense for a fleet that can trade.
    (el("run-buy") as HTMLAnchorElement).hidden = state !== "Active";

    const budget = view.budget;
    el("b-funded").textContent = `${toEth(budget.funded)} ETH`;
    el("b-spent").textContent = `${toEth(budget.spent)} ETH`;
    el("b-unused").textContent = `${toEth(budget.unused)} ETH`;
    const funded = Number(budget.funded) || 1;
    el("seg-spent").style.width = `${(Number(budget.spent) / funded) * 100}%`;
    el("seg-reserved").style.width = `${(Number(budget.reserved) / funded) * 100}%`;
    if (view.creditedToBalance !== undefined) {
      const returned = el("b-returned");
      returned.textContent = `${toEth(view.creditedToBalance)} ETH went back to your Chit balance.`;
      returned.hidden = false;
    } else if (view.returnedEth !== undefined) {
      const returned = el("b-returned");
      returned.textContent = `${toEth(view.returnedEth)} ETH returned to your wallet.`;
      returned.hidden = false;
    }
    this.#renderAccounts();
  }

  #renderAccounts(): void {
    const list = el("fleet-accounts");
    list.innerHTML = "";
    for (const account of this.#snapshot.accounts) {
      const item = document.createElement("li");
      item.dataset["wallet"] = account.toLowerCase();
      const address = document.createElement("span");
      address.className = "account-list__address";
      address.textContent = account;
      const holdings = document.createElement("span");
      holdings.className = "account-list__holdings";
      holdings.textContent = "…";
      item.append(address, holdings);
      list.appendChild(item);
    }
  }

  #showBalance(balance: CachedBalance): void {
    this.#available = String(balance.available ?? "0");
    this.#availableKnown = true;
    this.#poolPaused = Boolean(balance.pool?.paused);
  }

  /**
   * What each wallet holds now: ETH and the venue's tokens, read from the
   * chain by the service. Best effort; the list stays readable without it.
   */
  async #portfolio(wallet: `0x${string}`, body: Record<string, unknown>): Promise<void> {
    try {
      this.#renderPortfolio(await readSigned(wallet, "holdings", body));
    } catch {
      for (const node of Array.from(document.querySelectorAll<HTMLElement>("#fleet-accounts .account-list__holdings"))) node.textContent = "";
    }
  }

  #renderPortfolio(reply: Record<string, unknown>): void {
    const body = reply as {
      holdings?: { wallet: string; eth: string; tokens: Record<string, string> }[];
      symbols?: Record<string, string>;
    };
    if (this.#snapshot.accounts.length === 0 && body.holdings?.length) {
      this.#snapshot = { ...this.#snapshot, accounts: body.holdings.map((holding) => holding.wallet) };
      saveFleetSnapshot(this.#snapshot);
      this.#renderAccounts();
    }
    for (const holding of body.holdings ?? []) {
      const item = document.querySelector<HTMLElement>(`#fleet-accounts li[data-wallet="${holding.wallet.toLowerCase()}"] .account-list__holdings`);
      if (!item) continue;
      const parts = [`${toEth(holding.eth)} ETH`];
      for (const [token, amount] of Object.entries(holding.tokens)) {
        if (BigInt(amount) === 0n) continue;
        parts.push(`${toEth(amount)} ${body.symbols?.[token.toLowerCase()] ?? token.slice(0, 8)}`);
      }
      item.textContent = parts.join(" · ");
    }
  }

  /**
   * Reads the live campaign so the page shows the chain, not the snapshot.
   *
   * `asked`: the trader clicked for this. Without that, only what needs no
   * signature is read: the status always, the balance and holdings only from a
   * recent read. The page asks before it signs for the rest, so neither
   * opening it nor the funding poll ever opens the wallet on its own.
   */
  async #refresh(asked = false): Promise<void> {
    const wallet = getConnectedWallet();
    if (!wallet) return;
    try {
      const body = await readStatus(this.#snapshot.campaign);
      this.#draw = body.draw as DrawView | undefined;
      const state = body.state;
      this.#snapshot = { ...this.#snapshot, state };
      // Kept in step with the draw, so the next load paints today's figures
      // before the status answers, not the ones from when the fleet was made.
      if (this.#draw) {
        this.#snapshot.budget = { funded: this.#draw.amount, reserved: "0", spent: this.#draw.spent, unused: this.#draw.remaining };
        saveFleetSnapshot(this.#snapshot);
      }
      // A fleet still being funded is finished by requests like this one.
      const delay = pollDelayMs(state, this.#draw?.dueAt, new Date());
      if (delay !== undefined) globalThis.setTimeout(() => void this.#refresh(), delay);

      const holdingsBody = { campaign: this.#snapshot.campaign };
      const recent = recentBalance(wallet);
      const recentHoldings = recentSigned(wallet, "holdings", holdingsBody);
      if (!asked && (!recent || !recentHoldings)) {
        // A balance this page read earlier is withheld once its read is no
        // longer recent, exactly as every other surface withholds it.
        if (recent) this.#showBalance(recent);
        else this.#availableKnown = false;
        this.#render();
        if (recentHoldings) this.#renderPortfolio(recentHoldings);
        // Beside the figures it unlocks: the wallet list when only holdings
        // are hidden, else under the balance strip when it shows, else under the state.
        const strip = el("balance-strip");
        const anchor = recent
          ? el("wallets-note")
          : strip.hidden ? el("state-note") : (strip.querySelector<HTMLElement>("dl") ?? strip);
        // Ask for what is actually hidden, never for what is already on screen.
        // A balance showing from a recent read sitting above a button offering
        // to reveal it is the same figure hidden and shown at once.
        const ask = recent
          ? { lead: "What your fleet holds is private to your wallet.", label: "Show holdings" }
          : recentHoldings
            ? { lead: "Your Chit balance is private to your wallet.", label: "Show my balance" }
            : { lead: "Your balance and what your fleet holds are private to your wallet.", label: "Show them" };
        void askBeforeSigning(anchor, ask.lead, ask.label, "after").then(() => this.#refresh(true));
        return;
      }
      dropSigningAsk();
      this.#showBalance(await readBalance(wallet));
      this.#render();
      void this.#portfolio(wallet, holdingsBody);
    } catch (error) {
      // A campaign the service cannot find is one that was created but never
      // activated: it lived only in the memory of the instance that made it.
      // Keeping it would sign for a read that fails on every single load.
      if (
        (error instanceof RequestFailed || error instanceof StatusUnavailable) &&
        error.code === "state_invalid"
      ) {
        clearFleetSnapshot();
        el("fleet-view").hidden = true;
        el("no-fleet").hidden = false;
        banner(
          "That fleet was never activated, so it could not be resumed. Your Chit balance is untouched; start a new fleet from Set up.",
          "pending",
        );
        return;
      }
      // Anything else is a hiccup; the snapshot still renders.
    }
  }

  async #control(action: ControlAction): Promise<void> {
    if (action === "topUp") return this.#topUp();
    try {
      const question = confirmationFor(action);
      if (question && !(await confirmDialog(question))) return;
      const wallet = getConnectedWallet();
      if (!wallet) throw new Error("not_connected");
      const body = await signedFleetApi(wallet, action, { campaign: this.#snapshot.campaign });
      invalidateBalance(wallet);
      forgetSignedReads(wallet);
      const next: Record<ControlAction, string> = { pause: "Paused", resume: "Active", revoke: "Revoked", close: "Closed", topUp: "Active" };
      this.#snapshot = { ...this.#snapshot, state: next[action] };
      saveFleetSnapshot(this.#snapshot);
      banner(`Done. Fleet is now ${next[action].toLowerCase()}.`, "ok");
      void this.#refresh();
    } catch (error) {
      this.#pendingOrError(action, error);
    }
  }

  /** Raises this fleet's draw from the trader's balance (FR-013). */
  async #topUp(): Promise<void> {
    try {
      const wallet = getConnectedWallet();
      if (!wallet) throw new Error("not_connected");
      const amount = parseEth((el<HTMLInputElement>("topup-amount")).value);
      await signedFleetApi(wallet, "topUp", { campaign: this.#snapshot.campaign, amount });
      invalidateBalance(wallet);
      forgetSignedReads(wallet);
      banner("Topped up from your balance.", "ok");
      void this.#refresh();
    } catch (error) {
      this.#pendingOrError("topUp", error);
    }
  }



  #pendingOrError(action: string, error: unknown): void {
    const code = (error as Error).message;
    if (code.startsWith("dependency_evidence") || code.startsWith("status_503") || code.startsWith("challenge_invalid")) {
      banner("This control goes live with the testnet service. Nothing was changed.", "pending");
    } else {
      banner(`${action} didn't go through: ${code}`, "error");
    }
  }
}

/**
 * A fleet outlives the tab that made it. Without the wizard's snapshot the
 * wallet's list says which fleets exist, as it does on the Trade page: the
 * live one first, else the newest. Budget and accounts arrive with the
 * first status and holdings reads.
 */
const resumeFromService = async (): Promise<boolean> => {
  const wallet = getConnectedWallet();
  dropSigningAsk();
  if (!wallet) return false;
  if (!recentSigned(wallet, "list", {})) {
    await askBeforeSigning(el("no-fleet"), "Made a fleet in another tab? Your fleets are private to your wallet.", "Find my fleets");
    if (getConnectedWallet() !== wallet) return false;
  }
  let fleets: { campaign: string; state: string }[] = [];
  try {
    const body = (await readSigned(wallet, "list", {})) as { fleets?: { campaign: string; state: string }[] };
    fleets = body.fleets ?? [];
  } catch {
    return false;
  }
  const fleet = fleets.find((candidate) => isLiveState(candidate.state)) ?? fleets[0];
  if (!fleet) return false;
  const snapshot: FleetSnapshot = {
    campaign: fleet.campaign,
    state: fleet.state,
    budget: { funded: "0", reserved: "0", spent: "0", unused: "0" },
    accounts: [],
  };
  saveFleetSnapshot(snapshot);
  new FleetDashboard(snapshot).start();
  return true;
};

initHeaderWallet();
initShell();
const snapshot = loadFleetSnapshot();
if (snapshot) new FleetDashboard(snapshot).start();
else {
  const tryResume = async (): Promise<void> => {
    if (await resumeFromService()) window.removeEventListener("chit-wallet-changed", onWallet);
  };
  const onWallet = (): void => void tryResume();
  window.addEventListener("chit-wallet-changed", onWallet);
  void tryResume();
}
