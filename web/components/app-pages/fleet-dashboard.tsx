// Drawn from chit-fleet/app/fleet-dashboard.html by scripts/app-pages.mjs; every id and class is the one the app's logic reads.
/* eslint-disable */
export const meta = { title: "Chit Fleet · Dashboard", description: "Chit Fleet dashboard: watch your gas budget, pause, stop, or close your fleet.", skip: {"href":"#dash","label":"Skip to dashboard"} };

export function DashboardMarkup() {
  return (
    <>

      <p id="pool-status" className="pill" role="status" hidden><span className="pill__dot" aria-hidden="true"></span><span className="pill__text"></span></p>

      <main id="dash" className="dash">
        <div id="status-banner" className="status-banner" role="status" aria-live="polite" hidden></div>
        <p id="pool-paused" className="status-banner" data-tone="error" role="status" aria-live="polite" hidden></p>
        <section id="balance-strip" className="dash-card card-glass" aria-label="Your Chit balance and this fleet's draw" hidden>
          <dl className="summary grid">
            <div><dt>Your balance</dt><dd id="bal-available">—</dd></div>
            <div><dt>This fleet may spend</dt><dd id="draw-amount">—</dd></div>
            <div><dt>Spent</dt><dd id="draw-spent">—</dd></div>
            <div><dt>Left</dt><dd id="draw-remaining">—</dd></div>
          </dl>
          <div className="meter" id="draw-used-meter" role="meter" aria-label="How much of this fleet's draw is spent" aria-valuemin={0} aria-valuemax={1} aria-valuenow={0}><span className="meter__fill" id="draw-used-fill"></span></div>
          <div className="field">
            <label htmlFor="topup-amount">Top up this fleet (ETH)</label>
            <input id="topup-amount" name="topup" type="text" inputMode="decimal" defaultValue="0.01" />
            <button type="button" className="ghost" data-action="topUp">Top up</button>
          </div>
        </section>

        <section className="wstep empty-state" id="no-fleet" aria-labelledby="nf-h">
          <p className="kicker">Dashboard</p>
          <h1 id="nf-h">No fleet yet.</h1>
          <p className="lead">Set one up in about two minutes — connect, size it, save your backup, launch.</p>
          <a className="primary big linkbtn" href="./fleet.html">Set up a fleet</a>
        </section>

        <section id="fleet-view" hidden aria-labelledby="dash-h">
          <div className="dash-head">
            <h1 id="dash-h">Your fleet</h1>
            <span className="state-chip" id="state-chip" data-state="Active">Active</span>
          </div>
          <p className="state-note" id="state-note"></p>

          <div className="dash-card" data-reveal>
            <p className="cardlabel">Gas budget</p>
            <div className="budget-meter" role="img" aria-label="Budget usage" id="budget-meter">
              <span className="seg spent" id="seg-spent" style={{ width: "0%" }}></span>
              <span className="seg reserved" id="seg-reserved" style={{ width: "0%" }}></span>
            </div>
            <dl className="budget-grid">
              <div><dt>Funded</dt><dd id="b-funded">0 ETH</dd></div>
              <div><dt>Spent</dt><dd id="b-spent">0 ETH</dd></div>
              <div><dt>Left</dt><dd id="b-unused">0 ETH</dd></div>
            </dl>
            <p className="returned" id="b-returned" hidden></p>
          </div>

          <div className="dash-card" data-reveal>
            <p className="cardlabel">Controls</p>
            <div className="control-list">
              <button data-action="pause" type="button" disabled><strong>Pause</strong><span>Stop sponsoring for now. You can resume.</span></button>
              <button data-action="resume" type="button" disabled><strong>Resume</strong><span>Pick up where you paused.</span></button>
              <button data-action="revoke" type="button" disabled><strong>Stop for good</strong><span>Ends this fleet permanently. Cannot be undone.</span></button>
              <button data-action="close" type="button" disabled><strong>Close &amp; get ETH back</strong><span>Returns whatever the fleet didn't spend.</span></button>
            </div>
          </div>

          <div className="dash-card" data-reveal>
            <p className="cardlabel">Wallets and what they hold</p>
            <p className="lead small" id="wallets-note">Each wallet makes its trades in public; the link back to you stays off the chain. Balances are read from the chain each time this page refreshes.</p>
            <ul id="fleet-accounts" className="account-list" aria-label="Fleet wallets"></ul>
            <a id="run-buy" className="primary linkbtn" href="./trade.html">Trade from these wallets</a>
            <p className="hint" id="buy-note">Buys are placed as orders on the Trade page: a token, a total, and slices spread across the fleet and over time.</p>
          </div>
        </section>
      </main>

      <footer className="fleet-foot">
        <p>Testnet demonstration on Robinhood Chain. <a href="./fleet-privacy.html">Exactly what's private →</a></p>
        <p className="disclaimer">Chit is independent and not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap, or any other project named here.</p>
      </footer>
    
    </>
  );
}
