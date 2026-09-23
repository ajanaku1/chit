// Drawn from chit-fleet/app/balance.html by scripts/app-pages.mjs; every id and class is the one the app's logic reads.
/* eslint-disable */
export const meta = { title: "Chit Fleet · Your balance", description: "Your Chit balance: deposit ETH into the shared pool, fund fleets from it, and withdraw to an address you choose.", skip: {"href":"#balance","label":"Skip to your balance"} };

export function BalanceMarkup() {
  return (
    <>

      <p id="pool-status" className="pill" role="status" hidden><span className="pill__dot" aria-hidden="true"></span><span className="pill__text"></span></p>

      <main id="balance" className="wizard">
        <div id="status-banner" className="status-banner" role="status" aria-live="polite" hidden></div>

        <section className="wstep card-glass" aria-labelledby="balance-h" data-reveal>
          <p className="kicker">Your ETH at Chit</p>
          <h1 id="balance-h">One balance. Every fleet draws from it.</h1>
          <dl className="summary grid">
            <div><dt>Available at Chit</dt><dd id="balance-available">—</dd><dd id="balance-delta" className="delta" hidden></dd></div>
            <div><dt>Held by open fleets</dt><dd id="balance-draws">—</dd></div>
            <div><dt>In your wallet</dt><dd id="wallet-eth">—</dd></div>
            <div><dt>Deposited</dt><dd id="balance-deposited">—</dd></div>
            <div><dt>Spent</dt><dd id="balance-spent">—</dd></div>
            <div><dt>Figures</dt><dd><button id="balance-refresh" type="button" className="ghost">Refresh</button></dd></div>
          </dl>
          <div className="meter" id="headroom-meter" role="meter" aria-label="Balance against the 0.5 ETH limit" aria-valuemin={0} aria-valuemax={1} aria-valuenow={0}><span className="meter__fill" id="headroom-fill"></span></div>
          <p id="headroom-note" className="fineprint"></p>
          <p className="fineprint">{" "}
Your deposit goes into a pool shared with other traders and carries no fleet marker, so
            the chain does not show your wallet funding your fleet. Chit's operator can still see
            which balance paid for which fleet, and we say so plainly.
{" "}<a href="./fleet-privacy.html">Exactly what's private →</a>
          </p>
        </section>

        <aside className="limits" aria-label="Limits on your balance and fleets" data-reveal>
          <div className="card-warm limit"><p className="cardlabel">Funding delay</p><p className="limit__figure"><span data-led="15" data-unit="min">15 min</span></p><p className="limit__note">Chit waits up to 15 minutes before funding a fleet; the contract enforces at least a minute.</p></div>
          <div className="card-warm limit"><p className="cardlabel">Draw cap</p><p className="limit__figure"><span data-led="0.2" data-unit="ETH" data-cap="draw">0.2 ETH</span></p><p className="limit__note">The most one fleet may draw. Refused on chain above this.</p></div>
          <div className="card-warm limit"><p className="cardlabel">Self-serve exit</p><p className="limit__figure"><span data-led="24" data-unit="h">24 h</span></p><p className="limit__note">Recover your unspent deposit from the contract, with Chit offline.</p></div>
        </aside>

        <section className="wstep" aria-labelledby="deposit-h" data-reveal>
          <h2 id="deposit-h">Add ETH</h2>
          <p className="lead">{" "}
Deposits come in fixed sizes so yours looks like everyone else's. Pick one.
{" "}</p>
          <p id="deposit-custody" className="callout" role="note" data-beta-note hidden></p>
          <div id="deposit-sizes" className="quickpick" role="group" aria-labelledby="deposit-h"></div>
          <p id="deposit-note" className="fineprint" role="status" aria-live="polite"></p>
          <button id="deposit-submit" type="button" className="primary big" disabled>Add funds</button>
          <p id="deposit-gate-note" className="fineprint" data-beta-gate-note hidden></p>
        </section>

        <section className="wstep" aria-labelledby="withdraw-h" data-reveal>
          <h2 id="withdraw-h">Take ETH out</h2>
          <p className="callout">Paying out to the wallet you deposited from joins the two again on chain. Send to a fresh address.</p>
          <form id="withdraw-form" className="withdraw-form">
            <div className="field">
              <label htmlFor="withdraw-amount">Amount (ETH)</label>
              <input id="withdraw-amount" name="amount" type="text" inputMode="decimal" defaultValue="0.01" />
            </div>
            <div className="field">
              <label htmlFor="withdraw-destination">Send to</label>
              <input id="withdraw-destination" name="destination" type="text" placeholder="0x…" autoComplete="off" />
            </div>
            <p id="withdraw-note" className="fineprint" role="status" aria-live="polite"></p>
            <button id="withdraw-submit" type="submit" className="primary">Withdraw</button>
          </form>{" "}
{/* The withdrawal-refused state: what happened, try again, and the exit beside it. The same state covers a paused pool. */}
{" "}<div id="withdraw-refused" className="callout" role="alert" hidden>
            <p id="withdraw-refused-text"></p>
            <div className="wnav">
              <button id="withdraw-retry" type="button" className="ghost">Try again</button>
              <a className="primary" href="#exit-card">Take it out of the pool yourself</a>
            </div>
          </div>
        </section>

        <section id="exit-card" className="wstep card-warm" aria-labelledby="exit-h">
          <h2 id="exit-h">If Chit is ever unreachable</h2>
          <p className="lead">{" "}
You can take your unspent deposit straight from the pool contract, without us. Ask for
            it, wait 24 hours, then claim it. This works whether or not Chit is running.
{" "}</p>
          <p id="exit-status" className="fineprint" role="status" aria-live="polite">—</p>
          <div className="wnav">
            <button id="exit-request" type="button" className="ghost">Start a self-serve exit</button>
            <button id="exit-execute" type="button" className="primary" disabled>Claim it</button>
          </div>
        </section>
      </main>

      <footer className="fleet-foot">
        <p>Testnet demonstration on Robinhood Chain. Test ETH and a test token only, no real money.</p>
        <p className="disclaimer">Chit is independent and not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap, or any other project named here.</p>
      </footer>
    
    </>
  );
}
