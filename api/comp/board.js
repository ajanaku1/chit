// Plain JS on purpose: see api/fleet/campaign.js. The trading competition's
// board as JSON for /app/board and the bot's /board: public, no key, built at
// most once a minute and cached at the edge for as long.
import { handleBoardRequest } from "../../dist/src/fleet/comp-board-runtime.js";

export const config = { maxDuration: 60 };

export function GET(request) { return handleBoardRequest(request); }
