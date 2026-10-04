/**
 * Wallets let into the mainnet beta without holding the $CHIT line (the founder,
 * 2026-10-04): CHIT_HOLDER_ALLOWLIST, addresses separated by commas or
 * whitespace, any case. The web app's quote (eligibility.ts) and the bot's line
 * (bot-holders.ts) both read it; caps, sessions and everything else are as for
 * any holder. An entry that is not an address is left out and named in the log.
 */
export const holderAllowlistFrom = (raw: string | undefined, warn: (entry: string) => void = (e) => console.warn(`CHIT_HOLDER_ALLOWLIST: not an address, left out: ${e}`)): ReadonlySet<string> => {
  const out = new Set<string>();
  for (const entry of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (/^0x[0-9a-fA-F]{40}$/.test(entry)) out.add(entry.toLowerCase());
    else warn(entry);
  }
  return out;
};

export const holderAllowlistFromEnv = (): ReadonlySet<string> => holderAllowlistFrom(process.env.CHIT_HOLDER_ALLOWLIST);
