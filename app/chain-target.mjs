// The chain the app is built for, from the environment, at build time (T054).
// FLEET_CHAIN_ID picks the chain; the caps are the published set for it,
// which mirrors src/fleet/pool-caps.ts (app/test/beta-note.test.ts holds the
// two equal), overridable with FLEET_*_CAP_ETH exactly as a deploy is. On the
// mainnet beta the target carries the note FR-006 puts on every page: three
// facts, stated independently, in words no weaker than the specification's.
// Nothing here is read at runtime from a committed file: build.mjs writes
// chain-target.json from this and injects the note into every page, so a
// deploy cannot say one chain in its pages and another in its json.

const PUBLISHED = {
  46630: { chainName: "Robinhood Chain Testnet", rpcUrl: "https://rpc.testnet.chain.robinhood.com", caps: { depositor: "0.5", draw: "0.2", pool: "5" }, beta: false },
  4663: { chainName: "Robinhood Chain", rpcUrl: "https://rpc.mainnet.chain.robinhood.com", caps: { depositor: "0.1", draw: "0.05", pool: "1" }, beta: true },
};

const amount = (env, name, fallback) => {
  const raw = env[name];
  if (!raw) return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${name} must be an ETH amount like 0.1, got ${raw}`);
  return raw.replace(/\.?0+$/, "") || "0";
};

/** FR-006's three facts, each its own sentence, for a pool capped at `poolCap` ETH. */
export const betaFacts = (poolCap) => [
  `The pool is capped at ${poolCap} ETH.`,
  "The contracts have not been audited by a firm.",
  "Chit's operator key can move what is in the pool, up to that cap.",
];

/** FR-041 (T086): the caps are the beta's until the firm audit, said with the three facts and never as if the audit had happened. */
export const CAPS_UNTIL_AUDIT = "The caps stay until a professional audit is complete.";

/** T058: said once where a depositor reads it. The gate is the interface's; the pool does not know about CHIT. */
export const GATE_SENTENCE = "This gate is the interface's only: the contract accepts a deposit within its caps from anyone who finds it.";

/**
 * The session account factory for a chain, or none. The Sessions page reads
 * this to find a trader's own account; a factory belongs to the chain it was
 * deployed on, so a build for one chain must never ship the other's (T081,
 * FR-019: neither host offers the other's funds). 46630 is the deployed
 * testnet factory; 4663 has none until the beta deploys one, and an empty
 * target is what the page shows as "not deployed on this network yet",
 * which is true rather than an address that answers wrongly.
 * FLEET_SESSION_FACTORY sets it for a deploy exactly as the caps are set.
 */
const SESSION_FACTORIES = { 46630: "0xe6abb3aba7625c215f805ddc762e1148860796be", 4663: "" };

export const sessionTargetFromEnv = (env = process.env) => {
  const chainId = Number(env.FLEET_CHAIN_ID || 46630);
  if (!(chainId in SESSION_FACTORIES)) throw new Error(`FLEET_CHAIN_ID=${chainId} is not a chain this app is built for (46630 or 4663)`);
  const override = env.FLEET_SESSION_FACTORY;
  if (override !== undefined && override !== "" && !/^0x[0-9a-fA-F]{40}$/.test(override)) throw new Error(`FLEET_SESSION_FACTORY must be an address, got ${override}`);
  return { chainId, sessionFactory: (override ?? SESSION_FACTORIES[chainId]).toLowerCase() };
};

export const chainTargetFromEnv = (env = process.env) => {
  const chainId = Number(env.FLEET_CHAIN_ID || 46630);
  const published = PUBLISHED[chainId];
  if (!published) throw new Error(`FLEET_CHAIN_ID=${chainId} is not a chain this app is built for (46630 or 4663)`);
  const caps = {
    depositor: amount(env, "FLEET_DEPOSITOR_CAP_ETH", published.caps.depositor),
    draw: amount(env, "FLEET_DRAW_CAP_ETH", published.caps.draw),
    pool: amount(env, "FLEET_POOL_CAP_ETH", published.caps.pool),
  };
  const facts = published.beta ? betaFacts(caps.pool) : [];
  return {
    chainId,
    chainName: published.chainName,
    rpcUrls: [env.FLEET_RPC_URL || published.rpcUrl],
    caps,
    beta: published.beta,
    betaNote: published.beta ? `Beta on ${published.chainName}. ${facts.join(" ")} ${CAPS_UNTIL_AUDIT}` : "",
    betaFacts: facts,
    // Where the holders gate sends a wallet below the line: to buy CHIT, and to the free testnet. Empty means no link.
    // The pool this build's pages act on. The brake page needs it without asking the
    // service, since the service being unreachable is one reason to pull the brake.
    pool: env.FLEET_POOL_ADDRESS || "",
    buyChitUrl: env.CHIT_BUY_URL || "",
    testnetUrl: env.FLEET_TESTNET_URL || "",
  };
};

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Puts the beta note into a page: one strip before the masthead that nothing
 * closes, hides or scrolls past (the style is sticky), and the same statement
 * into every element marked data-beta-note, which the deposit form has beside
 * the amount (FR-007). Off the beta the strip is not written and the marked
 * elements stay hidden.
 */
export const withBetaNote = (html, target) => {
  if (!target.beta) return html;
  const facts = [...target.betaFacts, CAPS_UNTIL_AUDIT].map((fact) => `<span>${escape(fact)}</span>`).join(" ");
  const strip = `<p id="beta-note" class="beta-note" role="note"><strong>Beta on ${escape(target.chainName)}.</strong> ${facts}</p>\n      `;
  const marked = html
    .replace(/<(\w+)([^>]*)\sdata-beta-note([^>]*)\shidden([^>]*)>(?:[^<]*)<\/\1>/g, (_, tag, a, b, c) => `<${tag}${a} data-beta-note${b}${c}>${escape(target.betaNote)}</${tag}>`)
    .replace(/<(\w+)([^>]*)\sdata-beta-gate-note([^>]*)\shidden([^>]*)>(?:[^<]*)<\/\1>/g, (_, tag, a, b, c) => `<${tag}${a} data-beta-gate-note${b}${c}>${escape(GATE_SENTENCE)}</${tag}>`);
  return marked.replace(/(<header class="masthead">)/, `${strip}$1`);
};

/**
 * The caps a page states before the pool has answered are the target's, not a
 * number of the page's own (FR-001, T059): the draw cap figure on the Balance
 * page and the wizard's meter label are rewritten from the target; at runtime
 * the pool's own caps replace them.
 */
export const withCaps = (html, target) => html
  .replace(/data-led="[0-9.]+" data-unit="ETH" data-cap="draw">[0-9.]+ ETH/g, `data-led="${target.caps.draw}" data-unit="ETH" data-cap="draw">${target.caps.draw} ETH`)
  .replace(/aria-label="This draw against the [0-9.]+ ETH cap"/g, `aria-label="This draw against the ${target.caps.draw} ETH cap"`);
