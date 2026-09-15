/**
 * Trade page bootstrap. The order-driving logic lands in the next task; this
 * only wires the shared shell so the bundle exists and the page renders.
 */

import { initHeaderWallet, initShell } from "./fleet/page-shared.js";

initHeaderWallet();
initShell();
