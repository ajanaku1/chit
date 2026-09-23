// Drawn from chit-fleet/app/sessions.html by scripts/app-pages.mjs; every id and class is the one the app's logic reads.
/* eslint-disable */
export const meta = { title: "Chit · Session keys", description: "Session keys: give your bot a bounded key with a kill switch instead of your wallet. One contract, your rules, revoke in one transaction.", skip: {"href":"#sessions","label":"Skip to your sessions"} };

export function SessionsMarkup() {
  return (
    <>

      <p id="pool-status" className="pill" role="status" hidden><span className="pill__dot" aria-hidden="true"></span><span className="pill__text"></span></p>

      <main id="sessions" className="wizard">
        <div id="status-banner" className="status-banner" role="status" aria-live="polite" hidden></div>

        <section className="wstep card-glass" aria-labelledby="sessions-h" data-reveal>
          <p className="kicker">Session keys</p>
          <h1 id="sessions-h">Give your bot a key that can only do what you said.</h1>
          <p className="lead">{" "}
Anyone running a bot today hands it their wallet key. Here you keep the wallet. You fund a
            small account of your own, and you hand the bot a session: which contract, which function,
            how much ETH per trade and in total, until when. Pause it or revoke it from your wallet in
            one transaction. Chit is not in the loop: no operator, no service, nothing of yours held.
{" "}</p>
          <dl className="summary grid">
            <div><dt>Your account</dt><dd id="account-address">—</dd></div>
            <div><dt>ETH in it</dt><dd id="account-eth">—</dd></div>
            <div><dt>Status</dt><dd id="account-state">—</dd></div>
            <div><dt>Figures</dt><dd><button id="account-refresh" type="button" className="ghost">Refresh</button></dd></div>
          </dl>
          <p id="account-note" className="fineprint" role="status" aria-live="polite">Connect your wallet to see your account.</p>
          <div className="wnav">
            <button id="account-create" type="button" className="primary" disabled>Create my account</button>
          </div>
        </section>

        <section className="wstep" aria-labelledby="fund-h" data-reveal>
          <h2 id="fund-h">Fund it</h2>
          <p className="lead">ETH goes from your wallet to your account. Only your sessions can spend it, only within their rules; you take the rest back any time.</p>
          <form id="fund-form" className="withdraw-form">
            <div className="field">
              <label htmlFor="fund-amount">Amount (ETH)</label>
              <input id="fund-amount" name="amount" type="text" inputMode="decimal" defaultValue="0.01" />
            </div>
            <p id="fund-note" className="fineprint" role="status" aria-live="polite"></p>
            <button id="fund-submit" type="submit" className="primary" disabled>Send to my account</button>
          </form>
          <form id="withdraw-form" className="withdraw-form">
            <div className="field">
              <label htmlFor="withdraw-amount">Take back (ETH)</label>
              <input id="withdraw-amount" name="amount" type="text" inputMode="decimal" defaultValue="0.01" />
            </div>
            <p id="withdraw-note" className="fineprint" role="status" aria-live="polite"></p>
            <button id="withdraw-submit" type="submit" className="ghost" disabled>Withdraw to my wallet</button>
          </form>
        </section>

        <section className="wstep" aria-labelledby="grant-h" data-reveal>
          <h2 id="grant-h">Grant a session</h2>
          <p className="lead">The bot's key is the address its process signs with. It pays its own gas; your account pays the trades.</p>
          <form id="grant-form" className="withdraw-form">
            <div className="field">
              <label htmlFor="grant-key">The bot's key</label>
              <input id="grant-key" name="key" type="text" placeholder="0x…" autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="grant-target">Contract it may call</label>
              <input id="grant-target" name="target" type="text" placeholder="0x… (the Universal Router is filled in)" autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="grant-selector">Function (4-byte selector; blank lets the key call any function of that contract)</label>
              <input id="grant-selector" name="selector" type="text" placeholder="0x3593564c" autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="grant-per-call">Max ETH per call</label>
              <input id="grant-per-call" name="perCall" type="text" inputMode="decimal" defaultValue="0.001" />
            </div>
            <div className="field">
              <label htmlFor="grant-cap">Max ETH in total</label>
              <input id="grant-cap" name="cap" type="text" inputMode="decimal" defaultValue="0.005" />
            </div>
            <div className="field">
              <label htmlFor="grant-hours">Valid for (hours)</label>
              <input id="grant-hours" name="hours" type="text" inputMode="numeric" defaultValue="24" />
            </div>
            <p id="grant-note" className="fineprint" role="status" aria-live="polite"></p>
            <button id="grant-submit" type="submit" className="primary" disabled>Grant</button>
          </form>
        </section>

        <section className="wstep" aria-labelledby="list-h" data-reveal>
          <h2 id="list-h">Your sessions</h2>
          <p className="lead small">Read from the chain, never from us. Pause holds a key; revoke ends it for good. What a key can do is what its rules name, with the account's ETH inside the caps: the router's one function with the beta's defaults, or any function of any contract you name if you leave the selector blank, a token's own transfer included, so name only what the bot needs. "Let it sell" is one more thing you grant: without it the key cannot call sell, so the tokens the account holds go back to ETH only by your hand; with it the key can sell what the account holds back into the account, at the price of the pool it names, and turning it off is complete, since nothing of a sale outlives the call.</p>
          <div id="session-list" className="control-list"></div>
          <p id="list-empty" className="fineprint">No sessions yet on this device. A session granted elsewhere shows up once you paste its key above and press Refresh.</p>
        </section>

        <section className="wstep card-glass" aria-labelledby="link-h" data-reveal id="link-section" hidden>
          <h2 id="link-h">Link to the bot</h2>
          <p className="lead small">You came from Chit Bot. Create and fund your account above, grant the bot's key a session (its key and the beta's caps are filled in), then sign one message so the bot knows which account is yours. The bot never sees your key; the signature is the only proof it gets.</p>
          <p className="fineprint">The bot's key: <code id="link-key">…</code>. The message you sign names this chain, your account and a one-time code; it is good for 15 minutes.</p>
          <p id="link-note" className="fineprint" role="status" aria-live="polite"></p>
          <button id="link-submit" type="button" className="primary" disabled>Link to the bot</button>
        </section>

        <section className="wstep card-glass" aria-labelledby="lead-h" data-reveal id="lead-section" hidden>
          <h2 id="lead-h">Lead from this wallet</h2>
          <p className="lead small">You came from Chit Bot to lead from the wallet you already trade with. No account, no session, no key handed over: connect that wallet and sign one message. From then on every ETH buy it makes on the venue is read from the chain within a few minutes, posted to the leaders' feed with its hash, and mirrored into your followers' own session accounts, each inside the caps they set and behind orus's read. Your sells are never mirrored. Close leader in the bot stops it any time; the wallet's own trades are never touched.</p>
          <form id="lead-form" className="withdraw-form">
            <div className="field">
              <label htmlFor="lead-handle">Your name on the leaders list (letters, digits, spaces, _ . - and up to 32; no @)</label>
              <input id="lead-handle" name="handle" type="text" maxLength={32} autoComplete="off" />
            </div>
            <p className="fineprint">The message you sign names this chain, this wallet and a one-time code; it is good for 15 minutes. The signature is the only proof the bot gets, and a signature moves nothing.</p>
            <p id="lead-note" className="fineprint" role="status" aria-live="polite"></p>
            <button id="lead-submit" type="submit" className="primary" disabled>Lead from this wallet</button>
          </form>
        </section>

        <section className="wstep card-warm" aria-labelledby="bot-h" data-reveal>
          <h2 id="bot-h">For your bot</h2>
          <p className="lead small">One call. The account executes it with its own ETH; the bot's key only signs.</p>
          <pre className="hint" id="bot-snippet">account.execute(target, valueWei, calldata)   // from the key you granted
canExecute(key, target, selector, value)      // ask first, it says why not</pre>
          <p className="fineprint">The SDK is <code>src/fleet/session-keys.ts</code> in the repo: the ABI, the encoders, and <code>canExecute</code> so a bot never pays gas for a refusal.</p>
        </section>
      </main>

      <footer className="fleet-foot">
        <p>Testnet demonstration on Robinhood Chain. Test ETH and a test token only, no real money.</p>
        <p className="disclaimer">Chit is independent and not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap, or any other project named here.</p>
      </footer>
    
    </>
  );
}
