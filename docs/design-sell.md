# Selling a fleet's tokens on the beta

Decided 2026-09-27 by the founder, to ship before the beta opens. The deployed
contracts cannot sell for a fleet (the session policy allows one router call,
the buy) and cannot credit sale proceeds to a depositor (the pool has no such
function). Both stay as they are. Selling happens around them, through the one
path every fleet account already has: its owner's `withdrawToken`.

## The flow

1. **Sell, on the Trade page.** The depositor picks a token their fleet holds
   and names a **payout wallet**. The page refuses their main wallet, and says
   why (below).
2. **Unlock.** The fleet's owner keys live only in the backup file made at
   setup, encrypted with a signature from the main wallet. The page asks for the
   file and the signature, as the recovery step already does.
3. **Gas.** Owner keys hold no ETH. The service sends each owner key that holds
   the token just enough gas for one transfer, from the operator. The chain
   already shows Chit funding fleets, so this links nothing new.
4. **Transfer.** Each owner key calls `withdrawToken(token, operator, balance)`
   on its fleet account. The page sends the transaction hashes to the service.
5. **Verify.** The service checks each hash on 4663 before it counts: a
   `Transfer` of that token, from an account enrolled in this campaign, to the
   operator. A hash counts once, ever.
6. **Sell.** The operator sells the total through the registry's pool for that
   token, with the same bound buys have: never below the quote less
   `slippageBps`. A sale that cannot fill inside the bound is retried; after
   three misses the tokens are sent to the payout wallet instead, so a depositor
   is never left holding a claim on tokens Chit could not sell.
7. **Pay out.** The ETH goes to the payout wallet after a random 10 to 30
   minutes, so the sale and the payout do not sit side by side on chain.

## Rules the code keeps

- Only the campaign's own depositor can ask, with a signed request, as every
  other fleet action.
- Only registry tokens that are enabled. Anything else is refused.
- **Proceeds owed are not float.** The operator key holds users' proceeds
  between sale and payout. The service keeps "proceeds owed" in the store, and
  every check of the operator's float (the half-float alert, the refusal of a
  withdrawal the float cannot cover) subtracts it.
- Every step is recorded before its transaction is sent, like the rest of the
  money path, so a process that dies mid-sale leaves a record to resume from,
  not a sale to repeat.
- A failed sale, a missed payout and a sale held past an hour alert the monitor
  chat immediately.

## What changes in what we promise

These are the sentences the Trade page shows beside Sell, and the announcement
adds:

> Selling goes through Chit. Your fleet sends the tokens to Chit's operator,
> which sells them and pays the ETH to the payout wallet you name, 10 to 30
> minutes later. Between the sale and the payout, Chit holds your proceeds, and
> the pool's cap and the 24-hour exit do not cover them.

> Use a payout wallet that has never sent to or received from your main wallet.
> Paying out to your main wallet would link it to your fleet, so the page does
> not allow it. If you later move the ETH to your main wallet yourself, that
> creates the link.

## What this is not

- Not a contract change. The pool, the policy and the fleet accounts are the
  ones deployed on 2026-09-27.
- Not a separate key. The operator sells and pays out, as the founder decided;
  the proceeds-owed accounting above is what keeps that honest.
- Not the end state. A pool that credits sale proceeds to a depositor on chain
  belongs in the next pool, the one that replaces the beta's after the audit.
