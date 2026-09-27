/**
 * What the trade page says when the service refuses an order. The service
 * sends a code and, beside it, a reason (campaign-routes.ts); the reason is the
 * part a trader can act on, so it is read first.
 */

const ERROR_TEXT: Record<string, string> = {
  no_pool: "No ETH pool for this token.",
  over_draw: "More than this fleet has left.",
  over_cap: "A slice would pass the per-trade cap.",
  exit_pending: "You have an exit in progress; nothing new can leave the pool.",
};

const NOT_SPONSORABLE = "state_not_sponsorable:";

export const orderErrorText = (code: string, reason?: string): string => {
  if (code in ERROR_TEXT) return ERROR_TEXT[code]!;
  const refusal = [reason, code].find((s) => s?.startsWith(NOT_SPONSORABLE));
  if (refusal === `${NOT_SPONSORABLE}Activating`) {
    return "Your fleet is still being funded. The wait is deliberate; place the order once it shows as funded.";
  }
  if (refusal) return "This fleet is not active.";
  return `Something went wrong: ${code}`;
};
