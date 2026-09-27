/**
 * What a depositor is told about a sale (docs/design-sell.md): what sold, for
 * how much ETH, where the ETH goes and in how many minutes, and while a sale
 * runs, where the tokens are. Found in the first real sale: the page said
 * "sold" in one grey line and kept showing the tokens, so the founder sold
 * again. Pure, so the words are pinned by app/test/sell-receipt.test.ts.
 */

export type SaleView = {
  state?: string; token?: string; payout?: string; amountIn?: string;
  ethOut?: string; payoutDueAt?: number; saleTx?: string; payoutTx?: string;
};

export type Receipt = { title: string; lines: string[]; link?: { href: string; label: string } | undefined };

/** Explorers we know the address of; anywhere else, no link rather than a guessed one. */
const EXPLORERS: Record<number, string> = { 4663: "https://robinhoodchain.blockscout.com" };

const WEI = 10n ** 18n;

/** 18-decimal units cut to `places` decimals, with thousands separators: "11,017.06". */
const units = (value: string | undefined, places: number): string => {
  const v = BigInt(value ?? "0");
  const whole = (v / WEI).toLocaleString("en-US");
  const frac = (v % WEI).toString().padStart(18, "0").slice(0, places).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

/** ETH to six decimals, rounded: 0.000786502 reads 0.000787. */
const eth = (wei: string | undefined): string => {
  const step = 10n ** 12n;
  const rounded = ((BigInt(wei ?? "0") + step / 2n) / step) * step;
  return units(rounded.toString(), 6) || "0";
};

const short = (address = ""): string => (address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

const when = (dueAt: number | undefined, now: number): string => {
  const minutes = Math.ceil(((dueAt ?? now) - now) / 60_000);
  if (minutes <= 0) return "any moment now";
  const clock = new Date(dueAt ?? now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}, by ${clock}`;
};

const txLink = (chainId: number, hash: string | undefined, label: string): Receipt["link"] => {
  const base = EXPLORERS[chainId];
  return base && hash ? { href: `${base}/tx/${hash}`, label } : undefined;
};

export const saleReceipt = (sale: SaleView, ctx: { symbol: string; now: number; chainId: number }): Receipt => {
  const sold = `${units(sale.amountIn, 2)} ${ctx.symbol}`;
  const to = short(sale.payout);
  if (sale.state === "paid") {
    return { title: `Paid: ${eth(sale.ethOut)} ETH is in ${to}`, lines: [`From selling ${sold}.`], link: txLink(ctx.chainId, sale.payoutTx, "See the payout") };
  }
  if (sale.state === "sold") {
    return {
      title: `Sold ${sold} for ${eth(sale.ethOut)} ETH`,
      lines: [`The ETH goes to your payout wallet ${to} ${when(sale.payoutDueAt, ctx.now)}.`, "The wait is deliberate: it keeps the sale and the payout from sitting side by side on chain."],
      link: txLink(ctx.chainId, sale.saleTx, "See the sale"),
    };
  }
  if (sale.state === "returned") {
    return { title: `Not sold: your ${ctx.symbol} was returned`, lines: [`It could not be sold inside its price bound, so ${sold} went to your payout wallet ${to}.`], link: txLink(ctx.chainId, sale.payoutTx, "See the return") };
  }
  return { title: `Your ${sold} is with Chit's operator`, lines: ["It is being sold now. This page updates when it is done; if you leave, it finishes anyway."] };
};

/** Where the tokens are while the fleet sends them. */
export const sendingLine = (symbol: string, sent: number, of: number): string =>
  `Sending ${symbol} from your fleet's wallets to Chit's operator: ${sent} of ${of} done.`;
