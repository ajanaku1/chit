/**
 * The fill a depositor accepts is the estimate for the total they order, and
 * nothing else. The service refuses each slice whose own quote falls short of
 * its share of this figure (campaign-routes.ts, price_moved), so a figure
 * quoted for another total would refuse every slice for a price that never
 * moved.
 */
export const acceptedFor = (
  quote: { estimatedOut: string } | undefined,
  quotedTotalWei: string | undefined,
  totalWei: string,
): string | undefined => (quote && quotedTotalWei === totalWei ? quote.estimatedOut : undefined);
