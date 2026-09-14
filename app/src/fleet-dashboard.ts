/**
 * Fleet dashboard: watch the budget, pause/resume/stop/close, run the buy.
 * Reads the public snapshot the wizard saved; without one it points the user
 * back to setup. Lifecycle buttons offer only what the current state legally
 * allows, straight from the tested control-room view.
 */

import { buildBuyReport, buildControlRoomView, confirmationFor, isLiveState, type AccountBuyResult, type CampaignState, type ControlAction } from "./fleet/control-room.js";
import { clearFleetSnapshot, confirmDialog, getConnectedWallet, initHeaderWallet, initShell, loadFleetSnapshot, parseEth, saveFleetSnapshot, toEth, type FleetSnapshot } from "./fleet/page-shared.js";
import { invalidateBalance, readBalance } from "./fleet/balance-read.js";
import { StatusUnavailable, readStatus } from "./fleet/status-read.js";
import { RequestFailed, signedFleetApi } from "./fleet/signed-request.js";
import type { DrawView } from "./fleet/control-room.js";
import { capShare, pollDelayMs, stateLabel } from "./fleet/balance.js";
import { renderLed } from "./fleet/led.js";

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node as T;
};

const banner = (message: string, tone: "pending" | "error" | "ok"): void => {
  const node = el("status-banner");
  node.textContent = message;
  node.dataset["tone"] = tone;
  node.hidden = false;
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
    el("run-buy").addEventListener("click", () => void this.#runBuy());
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
      renderLed(el("bal-available"), toEth(this.#available), "ETH");
      renderLed(el("draw-amount"), toEth(this.#draw.amount), "ETH");
      renderLed(el("draw-spent"), toEth(this.#draw.spent), "ETH");
      renderLed(el("draw-remaining"), toEth(this.#draw.remaining), "ETH");
      const used = capShare(this.#draw.remaining, this.#draw.amount);
      el("draw-used-fill").style.setProperty("--fill", String(used));
      el("draw-used-meter").setAttribute("aria-valuenow", String(used));
    }
    const poolBanner = el("pool-paused");
    poolBanner.hidden = !view.poolPaused;
    poolBanner.textContent = view.poolNote ?? "";
    el("state-note").textContent = view.stateNote;
    for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-action]"))) {
      button.disabled = !view.availableActions.includes(button.dataset["action"] as ControlAction);
    }
    (el("run-buy") as HTMLButtonElement).disabled = state !== "Active";

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
      item.textContent = account;
      list.appendChild(item);
    }
  }

  /** Reads the live campaign so the page shows the chain, not the snapshot. */
  async #refresh(): Promise<void> {
    const wallet = getConnectedWallet();
    if (!wallet) return;
    try {
      const body = await readStatus(this.#snapshot.campaign);
      this.#draw = body.draw as DrawView | undefined;
      const state = body.state;
      this.#snapshot = { ...this.#snapshot, state };
      const balance = await readBalance(wallet);
      this.#available = String(balance.available ?? "0");
      this.#poolPaused = Boolean(balance.pool?.paused);
      this.#render();
      // A fleet still being funded is finished by requests like this one.
      const delay = pollDelayMs(state, this.#draw?.dueAt, new Date());
      if (delay !== undefined) globalThis.setTimeout(() => void this.#refresh(), delay);
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
      banner("Topped up from your balance.", "ok");
      void this.#refresh();
    } catch (error) {
      this.#pendingOrError("topUp", error);
    }
  }

  async #runBuy(): Promise<void> {
    try {
      const wallet = getConnectedWallet();
      if (!wallet) throw new Error("not_connected");
      const body = await signedFleetApi(wallet, "buy", {
        campaign: this.#snapshot.campaign,
        accounts: this.#snapshot.accounts,
        token: "0x0000000000000000000000000000000000000000",
        value: "0",
      });
      this.#renderBuyReport((body["results"] as AccountBuyResult[] | undefined) ?? []);
    } catch (error) {
      this.#pendingOrError("buy", error);
    }
  }

  #renderBuyReport(results: AccountBuyResult[]): void {
    const report = buildBuyReport(results);
    const rows = el("buy-rows");
    rows.innerHTML = "";
    for (const row of report.rows) {
      const tr = document.createElement("tr");
      const account = document.createElement("td");
      account.textContent = row.account;
      const status = document.createElement("td");
      status.textContent = row.status;
      status.className = row.status;
      tr.append(account, status);
      rows.appendChild(tr);
    }
    el("buy-report").hidden = false;
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

initHeaderWallet();
initShell();
const snapshot = loadFleetSnapshot();
if (snapshot) new FleetDashboard(snapshot).start();
