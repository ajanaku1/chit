// Drawn from chit-fleet/app/fleet.html by scripts/app-pages.mjs; every id and class is the one the app's logic reads.
/* eslint-disable */
import { DRAW_CAP } from "@/components/chain";

export const meta = { title: "Chit Fleet · Set up your fleet", description: "Chit Fleet: one private gas budget for all your trading wallets. Your keys stay with you; your main wallet stays out of sight.", skip: {"href":"#wizard","label":"Skip to setup"} };

export function FleetMarkup() {
  return (
    <>

      <p id="pool-status" className="pill" role="status" hidden><span className="pill__dot" aria-hidden="true"></span><span className="pill__text"></span></p>

      <main id="wizard" className="wizard">
        <div id="status-banner" className="status-banner" role="status" aria-live="polite" hidden></div>

        <ol className="dots" id="dots" aria-label="Setup progress">
          <li data-dot="welcome" aria-current="step"><span>Start</span></li>
          <li data-dot="connect"><span>Connect</span></li>
          <li data-dot="size"><span>Size</span></li>
          <li data-dot="backup"><span>Backup</span></li>
          <li data-dot="launch"><span>Launch</span></li>
        </ol>{" "}
{/* STEP 0: Welcome */}
{" "}<section className="wstep" data-wstep="welcome" aria-labelledby="welcome-h">
          <p className="kicker">Private gas for your trading wallets</p>
          <h1 id="welcome-h">One balance. Many wallets. Your main wallet stays out of it.</h1>
          <ul className="promises">
            <li><strong>You keep the keys.</strong> Your fleet's wallets are created in this browser and never leave it.</li>
            <li><strong>One balance.</strong> Add ETH once; every fleet you run draws from it.</li>
            <li><strong>Chit funds the fleet, not you.</strong> Your ETH goes into a shared pool that carries no fleet marker, and the fleet is funded from the pool, so no transaction joins the two.</li>
          </ul>
          <button id="start" type="button" className="primary big">Get started</button>
          <p className="fineprint">{" "}
Before you start: launching needs ETH in your Chit balance
            (<a href="./balance.html" target="_blank" rel="noopener">add it in a new tab</a>). Setup asks your wallet for a
            few free signatures and sends no transactions from it.
{" "}</p>
          <p className="fineprint">Testnet demonstration. <a href="./fleet-privacy.html">Exactly what's private →</a></p>
        </section>{" "}
{/* STEP 1: Connect */}
{" "}<section className="wstep" data-wstep="connect" hidden aria-labelledby="connect-h">
          <p className="kicker">Step 1 of 4</p>
          <h2 id="connect-h">Connect your wallet</h2>
          <p className="lead">This wallet approves the setup and locks your backup. It never touches the fleet on-chain.</p>
          <button id="connect-wallet" type="button" className="primary big">Connect wallet</button>
          <p id="wallet-line" className="mono-line" hidden></p>
          <p id="eligibility-line" className="eligibility-line" hidden></p>
        </section>{" "}
{/* STEP 2: Size the fleet */}
{" "}<section className="wstep" data-wstep="size" hidden aria-labelledby="size-h">
          <p className="kicker">Step 2 of 4</p>
          <h2 id="size-h">Size your fleet</h2>
          <p id="balance-first" className="warnbox" role="status" hidden>{" "}
Your Chit balance is 0 ETH, and a fleet spends from it.
{" "}<a href="./balance.html" target="_blank" rel="noopener">Add ETH in a new tab</a>, then carry on here: this setup
            stays where it is.
{" "}</p>
          <form id="size-form" noValidate>
            <div className="bigfield">
              <label htmlFor="f-wallets">How many wallets?</label>
              <input id="f-wallets" name="wallets" type="number" min="5" max="50" defaultValue="5" inputMode="numeric" />
              <span className="unit">5–50</span>
              <div className="quickpick" role="group" aria-label="Wallet presets">
                <button type="button" data-pick="f-wallets" data-value="5" aria-pressed="true">5</button>
                <button type="button" data-pick="f-wallets" data-value="10" aria-pressed="false">10</button>
                <button type="button" data-pick="f-wallets" data-value="20" aria-pressed="false">20</button>
                <button type="button" data-pick="f-wallets" data-value="50" aria-pressed="false">50</button>
              </div>
            </div>
            <div className="bigfield">
              <label htmlFor="f-budget">Gas budget</label>
              <input id="f-budget" name="budget" type="text" defaultValue="0.001" inputMode="decimal" />
              <span className="unit">ETH</span>
            </div>
            <div className="bigfield">
              <label htmlFor="f-duration">Runs for</label>
              <select id="f-duration" name="duration" defaultValue="7">
                <option value="1">1 day</option>
                <option value="7">1 week</option>
                <option value="30">1 month</option>
              </select>
              <div className="quickpick" role="group" aria-label="Duration presets">
                <button type="button" data-pick="f-duration" data-value="1" aria-pressed="false">1 day</button>
                <button type="button" data-pick="f-duration" data-value="7" aria-pressed="true">1 week</button>
                <button type="button" data-pick="f-duration" data-value="30" aria-pressed="false">1 month</button>
              </div>
            </div>

            <details className="advanced">
              <summary>Advanced settings</summary>
              <p className="hint">Preset to the verified Uniswap route on Robinhood testnet. Leave these alone unless you know why.</p>
              <div className="field">
                <label htmlFor="a-router">Router</label>
                <input id="a-router" name="router" type="text" defaultValue="0x8876789976decbfcbbbe364623c63652db8c0904" />
              </div>
              <div className="field">
                <label htmlFor="a-function">Function</label>
                <input id="a-function" name="function" type="text" defaultValue="execute(bytes,bytes[],uint256)" />
              </div>
              <div className="field">
                <label htmlFor="a-maxtrade">Max per trade (ETH)</label>
                <input id="a-maxtrade" name="maxTrade" type="text" defaultValue="0.0005" inputMode="decimal" />
              </div>
              <div className="field">
                <label htmlFor="a-pergas">Gas cap per wallet (ETH)</label>
                <input id="a-pergas" name="perGas" type="text" defaultValue="0.0002" inputMode="decimal" />
              </div>
            </details>

            <p id="size-error" className="field-error" role="alert" hidden></p>
            <div className="wnav">
              <button type="button" className="back" data-back>Back</button>
              <button type="submit" className="primary big">Continue</button>
            </div>
          </form>
        </section>{" "}
{/* STEP 3: Backup */}
{" "}<section className="wstep" data-wstep="backup" hidden aria-labelledby="backup-h">
          <p className="kicker">Step 3 of 4</p>
          <h2 id="backup-h">Save your backup</h2>
          <p className="lead">{" "}
Your fleet's keys exist only in this browser. We'll hand you one encrypted backup file — only your wallet's
            signature can ever open it.
{" "}</p>
          <div className="backup-card">
            <button id="generate-vault" type="button" className="primary big">Create fleet &amp; download backup</button>
            <p className="fineprint">Your wallet asks for two free signatures: one locks the backup, one registers the fleet.</p>
            <p id="vault-line" className="mono-line" hidden></p>
            <p className="warnbox" id="vault-warn" hidden>{" "}
Keep this file safe. If you lose it and this browser's data, nobody can recover the fleet — not even Chit.
{" "}</p>
            <button id="confirm-vault" type="button" className="ghost big" disabled>Sign to prove it opens</button>
            <p className="fineprint">Two more: one opens the backup to prove it works, one tells Chit it is safe.</p>
            <p id="confirm-line" className="mono-line" hidden></p>
          </div>
          <div className="wnav">
            <button type="button" className="back" data-back>Back</button>
            <button id="to-launch" type="button" className="primary big" disabled>Continue</button>
          </div>
        </section>{" "}
{/* STEP 4: Launch */}
{" "}<section className="wstep" data-wstep="launch" hidden aria-labelledby="launch-h">
          <p className="kicker">Step 4 of 4</p>
          <h2 id="launch-h">Launch your fleet</h2>
          <p className="lead">Commits part of your Chit balance to this fleet and switches it on. From then on, manage everything from the dashboard.</p>
          <dl className="summary" id="launch-summary"></dl>
          <div className="field">
            <label htmlFor="a-draw">How much of your balance may this fleet spend? (ETH)</label>
            <input id="a-draw" name="draw" type="text" inputMode="decimal" defaultValue="0.02" />
            <div className="meter" id="draw-meter" role="meter" aria-label={`This draw against the ${DRAW_CAP} ETH cap`} aria-valuemin={0} aria-valuemax={1} aria-valuenow={0}><span className="meter__fill" id="draw-fill"></span></div>
            <p id="draw-note" className="fineprint" role="status" aria-live="polite"></p>
            <p className="fineprint">{" "}
Your fleet spends from your Chit balance.
{" "}<a href="./balance.html" target="_blank" rel="noopener">Add ETH in a new tab →</a> Your setup here stays put.
{" "}</p>
            <button id="recheck-balance" type="button" className="ghost">I've added ETH: check my balance</button>
          </div>
          <button id="launch-fleet" type="button" className="primary big">Launch fleet</button>
          <p className="fineprint">One more free signature switches it on.</p>
          <div className="wnav">
            <button type="button" className="back" data-back>Back</button>
          </div>
        </section>{" "}
{/* DONE */}
{" "}<section className="wstep" data-wstep="done" hidden aria-labelledby="done-h">
          <p className="kicker">All set</p>
          <h2 id="done-h">Your fleet is ready.</h2>
          <div className="gauge" id="funding-gauge" hidden aria-hidden="true">
            <svg viewBox="0 0 120 66"><path className="gauge__track" d="M10 60 A50 50 0 0 1 110 60" /><line className="gauge__needle" id="funding-needle" x1="60" y1="60" x2="60" y2="16" /></svg>
          </div>
          <p id="funding-wait" className="fineprint" role="status" aria-live="polite"></p>
          <p className="lead">Watch the budget, pause or stop anytime, and get unused ETH back whenever you close.</p>
          <a className="primary big linkbtn" href="./fleet-dashboard.html">Open the dashboard</a>
        </section>

      </main>

      <footer className="fleet-foot">
        <p>Testnet demonstration on Robinhood Chain. Budget is ETH. No CHIT is required to create a fleet; holding CHIT is optional and only ever adds discounts and early access.</p>
        <p className="disclaimer">Chit is independent and not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap, or any other project named here.</p>
      </footer>
    
    </>
  );
}
