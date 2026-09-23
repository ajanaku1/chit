// Drawn from chit-fleet/app/fleet-privacy.html by scripts/app-pages.mjs; every id and class is the one the app's logic reads.
/* eslint-disable */
export const meta = { title: "Chit Fleet · What's private", description: "Exactly what Chit Fleet keeps private, what stays public, and who is trusted.", skip: {"href":"#privacy","label":"Skip to content"} };

export function PrivacyMarkup() {
  return (
    <>

      <p id="pool-status" className="pill" role="status" hidden><span className="pill__dot" aria-hidden="true"></span><span className="pill__text"></span></p>

      <main id="privacy" className="privacy-page">
        <p className="kicker">The honest version</p>
        <h1>What's private, what isn't.</h1>
        <p className="lead">{" "}
No fog, no fine print. Here is exactly where the line sits — the same line our tests enforce in code.
{" "}</p>

        <div className="boundary-grid">
          <section className="card-solid boundary-block" data-reveal>
            <h2>Everyone can see</h2>
            <ul id="public-facts"></ul>
          </section>
          <section className="card-glass boundary-block held" data-reveal>
            <h2>Kept off the chain</h2>
            <p id="private-fact"></p>
          </section>
          <section className="card-solid boundary-block" data-reveal>
            <h2>The fine print, said plainly</h2>
            <p id="privacy-claim"></p>
          </section>
          <section className="card-glass boundary-block" data-reveal>
            <h2>Once your fleet runs on the shared pool</h2>
            <p id="pool-claim"></p>
            <p className="fineprint">{" "}
Private, not anonymous. We are not a mixer and we do not try to make you disappear.
              The public cannot join your wallet to your fleet; Chit's operator can, and we say so
              rather than hide it. The direction we are building toward is a key you hold, so you
              decide who gets to see what.
{" "}</p>
          </section>
        </div>

        <h2 className="ex-h">What Chit Fleet will not do</h2>
        <p className="lead small">These are design decisions, not missing features:</p>
        <p className="exclusions" id="exclusions"></p>

        <a className="primary big linkbtn" href="./fleet.html">Set up a fleet</a>
      </main>

      <footer className="fleet-foot">
        <p>Testnet demonstration on Robinhood Chain.</p>
        <p className="disclaimer">Chit is independent and not affiliated with, sponsored by, or endorsed by Robinhood, Uniswap, or any other project named here.</p>
      </footer>
    
    </>
  );
}
