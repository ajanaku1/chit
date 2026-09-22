/**
 * The holders gate (FR-003, FR-004, FR-005; T055): on the beta, checked after
 * the wallet connects and before the app opens. Above the threshold: through,
 * silently. Below: what the wallet holds, what is required, where to buy CHIT
 * and where the free testnet is; never an error state. Unknown: the read
 * failed, so a retry; a read failure must never look like a rejection. The
 * threshold lives in the service's environment (CHIT_FEE_THRESHOLD), read
 * through the quote, so it moves without a deploy. It gates the interface,
 * not the contracts, and says so once (T058).
 */

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type GateState =
  | { state: "open" }
  | { state: "closed"; holdings: string; threshold: string }
  | { state: "unknown"; reason: string };

export type GateTarget = { chainName: string; buyChitUrl: string; testnetUrl: string };

/** What the quote said, or that it could not be had. Only a 200 with `eligible: false` closes the gate. */
export const gateState = (answer: { status: number; body: Record<string, unknown> } | { error: string }): GateState => {
  if ("error" in answer) return { state: "unknown", reason: answer.error };
  const { status, body } = answer;
  if (status !== 200 || typeof body["eligible"] !== "boolean") return { state: "unknown", reason: `the service answered ${status}` };
  if (body["eligible"]) return { state: "open" };
  return { state: "closed", holdings: typeof body["holdings"] === "string" ? body["holdings"] : "0", threshold: typeof body["threshold"] === "string" ? body["threshold"] : "0" };
};

/** CHIT base units (18 decimals) as a figure a person reads: "1,000 CHIT", "0.5 CHIT". */
export const formatChit = (units: string): string => {
  if (!/^\d+$/.test(units)) return "an unknown amount of CHIT";
  const whole = BigInt(units) / 10n ** 18n;
  const frac = BigInt(units) % 10n ** 18n;
  const head = whole.toLocaleString("en-US");
  const tail = frac === 0n ? "" : `.${frac.toString().padStart(18, "0").replace(/0+$/, "").slice(0, 4)}`;
  return `${head}${tail} CHIT`;
};

export const GATE_SENTENCE = "This gate is the interface's only: the contract accepts a deposit within its caps from anyone who finds it.";

/** The gate's inside, as markup, for the closed and unknown states; open renders nothing. */
export const gateMarkup = (state: GateState, target: GateTarget): string => {
  if (state.state === "open") return "";
  if (state.state === "unknown") {
    return [
      `<h2>Checking your CHIT</h2>`,
      `<p>We couldn't read your wallet's CHIT balance just now (${escapeHtml(state.reason)}). That is a read that failed, not a decision.</p>`,
      `<button type="button" class="primary" data-gate-retry>Try again</button>`,
    ].join("");
  }
  const buy = target.buyChitUrl ? `<a href="${escapeHtml(target.buyChitUrl)}" rel="noopener">Buy CHIT</a>` : `<span>CHIT trades on ${escapeHtml(target.chainName)}; the token address is in the header above.</span>`;
  const testnet = target.testnetUrl ? `<a href="${escapeHtml(target.testnetUrl)}" rel="noopener">Use the free testnet</a>` : "";
  return [
    `<h2>Chit's mainnet beta is open to CHIT holders</h2>`,
    `<p>You hold <strong>${escapeHtml(formatChit(state.holdings))}</strong>. You need <strong>${escapeHtml(formatChit(state.threshold))}</strong>.</p>`,
    `<p class="holders-gate__links">${buy}${testnet ? ` · ${testnet}` : ""}</p>`,
    `<p class="fineprint">${escapeHtml(GATE_SENTENCE)}</p>`,
  ].join("");
};

type Quote = () => Promise<{ status: number; body: Record<string, unknown> }>;

/**
 * Wires the gate to the page: a modal that cannot be dismissed while the gate
 * is closed or unknown, removed the moment it opens or the wallet disconnects.
 */
export const initHoldersGate = (target: GateTarget, quote: Quote): void => {
  let dialog: HTMLDialogElement | undefined;
  const drop = (): void => { dialog?.close(); dialog?.remove(); dialog = undefined; };
  const show = (state: GateState): void => {
    if (state.state === "open") { drop(); return; }
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "holders-gate";
      dialog.className = "holders-gate";
      dialog.setAttribute("aria-labelledby", "holders-gate-title");
      dialog.addEventListener("cancel", (event) => event.preventDefault());
      document.body.append(dialog);
    }
    dialog.innerHTML = gateMarkup(state, target).replace("<h2>", '<h2 id="holders-gate-title">');
    dialog.querySelector("[data-gate-retry]")?.addEventListener("click", () => void check());
    if (!dialog.open) dialog.showModal();
  };
  const check = async (): Promise<void> => {
    try {
      show(gateState(await quote()));
    } catch (error) {
      show(gateState({ error: error instanceof Error ? error.message : String(error) }));
    }
  };
  window.addEventListener("chit-wallet-changed", (event) => {
    const address = (event as CustomEvent<{ address?: string }>).detail?.address;
    if (address) void check();
    else drop();
  });
};
