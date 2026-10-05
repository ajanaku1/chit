/**
 * A phone browser with no wallet in it.
 *
 * On a desktop, "no wallet" means none is installed, and the fix is to install
 * one. On a phone it usually means the trader opened the page in Safari or
 * Chrome, where no wallet app can inject a provider. Every major wallet app has
 * a browser of its own that can, and a universal link that opens a page in it.
 * The page offers those links instead of telling a phone to install an
 * extension it cannot run.
 */

export type WalletAppLink = { name: string; href: string };

/** A phone or a tablet, including an iPad that reports itself as a Mac. */
export const isPhone = (userAgent: string, touchPoints = 0): boolean =>
  /iPhone|iPad|iPod|Android/i.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);

/**
 * The wallet apps' universal links, each carrying this page so the trader lands
 * back where they were, inside the wallet's browser. These are the links each
 * wallet documents, not deep-link schemes, so a phone without the app opens the
 * store page instead of nothing.
 */
export const walletAppLinks = (page: string): WalletAppLink[] => {
  const url = new URL(page);
  const bare = `${url.host}${url.pathname}${url.search}`;
  const whole = encodeURIComponent(url.href);
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${bare}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${whole}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${whole}` },
    { name: "Phantom", href: `https://phantom.app/ul/browse/${whole}?ref=${encodeURIComponent(url.origin)}` },
  ];
};
