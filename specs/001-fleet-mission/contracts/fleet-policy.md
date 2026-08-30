# Fleet Policy Contract

## Session authorization

The policy accepts a request only when its campaign is Active, the single session key is valid, the request targets a generated fleet account on the campaign chain, and it invokes the configured router/function within the maximum trade value, gas limits, total budget, and expiry.

## Rejections

The policy rejects arbitrary asset transfers, ownership changes, gas withdrawal, key authorization, unapproved contract calls, invalid account/chain bindings, expired campaigns, depleted budgets, Paused campaigns, and Revoked campaigns.

## Terminal control

Revoked cannot resume or rotate a session key. Close is its sole remaining action and returns unused campaign ETH to the owner.
