/**
 * "What's private" page: rendered from the same module constants the privacy
 * tests enforce, so the page can never drift from the claims the code makes.
 */

import { initHeaderWallet, initTheme } from "./fleet/page-shared.js";
import {
  FLEET_EXCLUDED_CAPABILITIES,
  FLEET_PRIVACY_CLAIM,
  FLEET_PRIVATE_FACT,
  FLEET_PUBLIC_FACTS,
  POOL_PRIVACY_CLAIM,
} from "./fleet/index.js";

initTheme();
initHeaderWallet();

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node;
};

const publicList = el("public-facts");
for (const fact of FLEET_PUBLIC_FACTS) {
  const item = document.createElement("li");
  item.textContent = fact;
  publicList.appendChild(item);
}
el("private-fact").textContent = FLEET_PRIVATE_FACT;
el("privacy-claim").textContent = FLEET_PRIVACY_CLAIM;
el("pool-claim").textContent = POOL_PRIVACY_CLAIM;
el("exclusions").textContent = `${FLEET_EXCLUDED_CAPABILITIES.join(", ")}.`;
