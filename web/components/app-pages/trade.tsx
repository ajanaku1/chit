// Drawn from chit-fleet/app/trade.html by scripts/app-pages.mjs; every id and class is the one the app's logic reads.
/* eslint-disable */
export const meta = { title: "Chit Fleet · Trade", description: "Chit Fleet Trade: buy a token with every wallet in your fleet, at its own moment.", skip: {"href":"#trade","label":"Skip to trade"} };

export function TradeMarkup() {
  return (
    <>

      <p id="pool-status" className="pill" role="status" hidden><span className="pill__dot" aria-hidden="true"></span><span className="pill__text"></span></p>

      <main id="trade" className="dash">
        <div id="status-banner" className="status-banner" role="status" aria-live="polite" hidden></div>
        <section className="dash-card" aria-labelledby="fleet-h">
          <div className="dash-head"><h1 id="fleet-h">Trade</h1><span id="fleet-chip" className="state-chip" data-live="false">No fleet</span></div>
          <label className="field"><span>Fleet</span><select id="fleet-switch" aria-label="Which fleet trades"></select></label>
          <dl className="summary"><div><dt>ETH left to spend</dt><dd id="fleet-left">—</dd></div></dl>
          <p className="cardlabel">Holdings</p>
          <dl className="summary" id="holdings"><div><dt>Nothing bought yet</dt><dd>—</dd></div></dl>
        </section>
        <section className="dash-card" aria-labelledby="order-h">
          <h2 id="order-h">Buy a token with every wallet</h2>
          <p className="lead">One token, one total. Each wallet buys its own slice, at its own moment, inside about the window shown. Trades stay public; only who funded the fleet is withheld.</p>
          <form id="order-form" noValidate>
            <div className="field"><label htmlFor="o-token">Token address</label><input id="o-token" name="token" type="text" inputMode="text" placeholder="0x…" autoComplete="off" /></div>
            <p id="o-quote" className="fineprint" role="status" aria-live="polite"></p>
            <div className="field"><label htmlFor="o-total">Total to spend (ETH)</label><input id="o-total" name="total" type="text" inputMode="decimal" defaultValue="0.005" /></div>
            <p id="o-plan" className="fineprint" role="status" aria-live="polite"></p>
            <p id="trade-error" className="field-error" role="alert" hidden></p>
            <button id="o-place" type="submit" className="primary big" disabled>Place order</button>
          </form>
        </section>
        <section className="dash-card" aria-labelledby="sell-h">
          <h2 id="sell-h">Sell back to ETH</h2>
          <p className="lead">Selling goes through Chit. Your fleet sends the tokens to Chit&apos;s operator, which sells them and pays the ETH to the payout wallet you name, 10 to 30 minutes later. Between the sale and the payout, Chit holds your proceeds, and the pool&apos;s cap and the 24-hour exit do not cover them.</p>
          <form id="sell-form" noValidate>
            <div className="field"><label htmlFor="s-token">Token</label><select id="s-token" name="token"></select></div>
            <div className="field"><label htmlFor="s-payout">Payout wallet</label><input id="s-payout" name="payout" type="text" inputMode="text" placeholder="0x…" autoComplete="off" /></div>
            <p className="fineprint">Use a wallet that has never sent to or received from your main wallet. Paying out to your main wallet would link it to your fleet, so it is not allowed. If you later move the ETH to your main wallet yourself, that creates the link.</p>
            <div className="field"><label htmlFor="s-backup">Your fleet&apos;s backup file</label><input id="s-backup" name="backup" type="file" accept="application/json,.json" /></div>
            <p className="fineprint">The file you saved when you set up the fleet. Your wallet signs once to open it; the keys inside never leave this page.</p>
            <p id="s-status" className="fineprint" role="status" aria-live="polite"></p>
            <p id="s-error" className="field-error" role="alert" hidden></p>
            <button id="s-sell" type="submit" className="primary big" disabled>Sell</button>
          </form>
          <div id="s-result" className="sale-receipt" role="status" aria-live="polite" hidden>
            <p id="s-result-title" className="sale-receipt__title"></p>
            <p id="s-result-lines" className="sale-receipt__lines"></p>
            <p className="sale-receipt__actions"><a id="s-result-link" target="_blank" rel="noopener" hidden></a><button id="s-check" type="button" className="ghost" hidden>Check the payout</button></p>
          </div>
        </section>
        <section className="dash-card" aria-labelledby="orders-h">
          <h2 id="orders-h">Orders</h2>
          <p className="cardlabel">Running</p>
          <ul id="orders-open" className="order-list"></ul>
          <p className="cardlabel">Past</p>
  <span id="copy-status" className="sr-only" role="status" aria-live="polite"></span>
          <ul id="orders-past" className="order-list"></ul>
        </section>
      </main>

      <footer className="fleet-foot">
        <p>Testnet demonstration on Robinhood Chain. <a href="./fleet-privacy">Exactly what's private →</a></p>
        <p className="disclaimer">Chit is independent and not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap, or any other project named here.</p>
      </footer>
    
    </>
  );
}
