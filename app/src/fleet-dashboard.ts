/**
 * Fleet dashboard: watch the budget, pause/resume/stop/close, run the buy.
 * Reads the public snapshot the wizard saved; without one it points the user
 * back to setup. Lifecycle buttons offer only what the current state legally
 * allows, straight from the tested control-room view.
 */

import { buildBuyReport, buildControlRoomView, type AccountBuyResult, type CampaignState, type ControlAction } from "./fleet/control-room.js";
import { fleetApi, initHeaderWallet, initTheme, loadFleetSnapshot, saveFleetSnapshot, toEth, type FleetSnapshot } from "./fleet/page-shared.js";

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
    this.#render();
  }

  #state(): CampaignState | undefined {
    return (KNOWN_STATES as readonly string[]).includes(this.#snapshot.state)
      ? (this.#snapshot.state as CampaignState)
      : undefined;
  }

  #render(): void {
    const chip = el("state-chip");
    chip.textContent = this.#snapshot.state;
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

    const view = buildControlRoomView({ campaign: this.#snapshot.campaign, state, budget: this.#snapshot.budget });
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
    if (view.returnedEth !== undefined) {
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

  async #control(action: ControlAction): Promise<void> {
    try {
      const { status, body } = await fleetApi(action, {
        action,
        auth: { action },
        body: { campaign: this.#snapshot.campaign },
      });
      if (status < 200 || status >= 300) throw new Error(String(body["code"] ?? `status_${status}`));
      const next: Record<ControlAction, string> = { pause: "Paused", resume: "Active", revoke: "Revoked", close: "Closed" };
      this.#snapshot = { ...this.#snapshot, state: next[action] };
      saveFleetSnapshot(this.#snapshot);
      banner(`Done — fleet is now ${next[action].toLowerCase()}.`, "ok");
      this.#render();
    } catch (error) {
      this.#pendingOrError(action, error);
    }
  }

  async #runBuy(): Promise<void> {
    try {
      const { status, body } = await fleetApi("buy", {
        action: "buy",
        auth: { action: "buy" },
        body: {
          campaign: this.#snapshot.campaign,
          accounts: this.#snapshot.accounts,
          token: "0x0000000000000000000000000000000000000000",
          value: "0",
        },
      });
      if (status < 200 || status >= 300) throw new Error(String(body["code"] ?? `status_${status}`));
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

initTheme();
initHeaderWallet();
const snapshot = loadFleetSnapshot();
if (snapshot) new FleetDashboard(snapshot).start();
