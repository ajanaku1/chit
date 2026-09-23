#!/usr/bin/env bash
# Chit — done predicates.
#
# Done means this script exits 0. Nothing else counts: not a session's summary,
# not a checked-off task list, not "it looked right when I ran it."
#
# THIS FILE STARTS RED. On a fresh scaffold every check fails because nothing is
# built yet — that is correct and expected. A verify.sh that passes on an empty
# directory is checking nothing.
#
# NEVER weaken a check to make it pass. If a predicate is wrong, fix the
# predicate deliberately and record it in IMPLEMENTATION.md; if the build is
# wrong, fix the build. Editing a check to match a broken build destroys the only
# objective artifact in the project.
#
# Usage:
#   ./verify.sh          run every check
#   ./verify.sh phase-1  run only the checks tagged phase-1

set -uo pipefail
cd "$(dirname "$0")"

FILTER="${1:-}"
pass=0; fail=0; executed=0

check() {
  local tag="$1" desc="$2"; shift 2
  if [ -n "$FILTER" ] && [ "$tag" != "$FILTER" ]; then return 0; fi
  executed=$((executed + 1))
  if "$@" >/dev/null 2>&1; then
    printf '  PASS  [%s] %s\n' "$tag" "$desc"; pass=$((pass + 1))
  else
    printf '  FAIL  [%s] %s\n' "$tag" "$desc"; fail=$((fail + 1))
  fi
}

checksh() {
  local tag="$1" desc="$2" cmd="$3"
  check "$tag" "$desc" sh -c "$cmd"
}

fleet_evidence_live() {
  local file mode chain rpc role address code bytecode
  file="test/fleet/fixtures/dependency-evidence.json"
  [ -f "$file" ] || return 1
  mode=$(jq -er '.mode' "$file") || return 1
  [ "$mode" = "live" ] || return 1
  rpc="${FLEET_RPC_URL:-}"
  [ -n "$rpc" ] || return 1
  chain=$(jq -er '.chainId | tonumber' "$file") || return 1
  curl -sS --max-time 10 -X POST "$rpc" -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | \
    jq -er --arg expected "$(printf '0x%x' "$chain")" '.result == $expected' >/dev/null || return 1
  for role in entryPoint escrow router venue; do
    address=$(jq -er --arg role "$role" '.dependencies[$role].address // empty' "$file") || return 1
    [ -n "$address" ] || return 1
    printf '%s' "$address" | grep -qE '^0x[0-9a-fA-F]{40}$' || return 1
    code=$(curl -sS --max-time 10 -X POST "$rpc" -H 'content-type: application/json' \
      --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$address\",\"latest\"]}" | jq -er '.result') || return 1
    printf '%s' "$code" | grep -qE '^0x[0-9a-fA-F]{2,}$' || return 1
    bytecode="${code#0x}"
    printf '%s' "$bytecode" | grep -qE '[1-9a-fA-F]' || return 1
  done
}

fleet_evidence_check() {
  local file
  file="test/fleet/fixtures/dependency-evidence.json"
  test -f tsconfig.fleet.json && test -f "$file" && test -f test/fleet/chain-dependencies.test.ts && test -f test/fleet/types.test.ts && test -f src/fleet/types.ts && test -f app/src/fleet/index.ts && test -f app/test/fleet-boundary.test.ts || return 1
  grep -qE '"build:fleet"' package.json && grep -qE '"test:fleet"' package.json || return 1
  if jq -e '.mode == "fixture" and .testOnly == true and .allowedClaim == "test-only-fixture"' "$file" >/dev/null; then :; else fleet_evidence_live; fi
  npm run build:fleet && node --test dist-fleet/test/fleet/chain-dependencies.test.js dist-fleet/test/fleet/types.test.js && npm --prefix app run verify
}


echo "== Chit verify =="

# --- Fleet Mission: isolated testnet acceptance family ----------------------
# These checks are intentionally red until the T001–T041 slice exists. They
# Fixture/scaffold checks make no network call; live mode uses only bounded configured RPC after guards.
check fleet-evidence "Fleet dependency evidence or labelled fixture is tested" fleet_evidence_check
checksh fleet-foundation "Fleet foundation outputs and tests pass" \
  'test -f contracts/fleet/FleetAccountFactory.sol && test -f contracts/fleet/FleetSessionPolicy.sol && test -f contracts/fleet/FleetCampaignEscrow.sol && test -f src/fleet/campaign-service.ts && test -f src/fleet/chain-service.ts && test -f test/fleet/campaign-state.test.ts && test -f test/fleet/session-policy.test.ts && test -f test/fleet/campaign-budget.test.ts && test -f test/fleet/campaign-service.test.ts && test -f test/fork/fleet-contracts.test.ts && npm run build:fleet && node --test dist-fleet/test/fleet/campaign-state.test.js dist-fleet/test/fleet/session-policy.test.js dist-fleet/test/fleet/campaign-budget.test.js dist-fleet/test/fleet/campaign-service.test.js dist-fleet/test/fleet/stateless-challenge.test.js && npx hardhat compile && npm run build && node --test dist/test/fork/fleet-contracts.test.js dist/test/fork/fleet-paymaster.test.js dist/test/fork/fleet-operator-executor.test.js dist/test/fork/fleet-chain-buy.test.js dist/test/fork/fleet-lifecycle.test.js dist/test/fork/fleet-service-chain.test.js dist/test/fork/fleet-deploy.test.js'
# The venue fork test needs the public 46630 RPC, which drops requests under
# load; three attempts of the same unchanged predicate, never a weaker one.
fleet_venue_check() {
  local i
  test -f contracts/fleet/FleetVenueToken.sol && test -f contracts/fleet/FleetPoolSeeder.sol && test -f src/fleet/v4-swap.ts \
    && test -f test/fleet/v4-swap.test.ts && test -f test/fork/fleet-venue.test.ts && test -f scripts/fleet-venue-live.ts || return 1
  npm run build:fleet && node --test dist-fleet/test/fleet/v4-swap.test.js && npx hardhat compile && npm run build || return 1
  for i in 1 2 3; do node --test dist/test/fork/fleet-venue.test.js && return 0; done
  return 1
}
check fleet-venue "Fleet venue: v4 buy calldata unit tests and the 46630-fork seeded-pool buy pass" fleet_venue_check
checksh fleet-create "Fleet CHIT fee and local-vault creation tests pass" \
  'test -f specs/001-fleet-mission/contracts/fleet-vault.md && test -f test/fleet/fee-charge.test.ts && test -f test/fleet/campaign-route.test.ts && test -f src/fleet/eligibility.ts && test -f api/fleet/campaign.js && test -f app/src/fleet/vault.ts && test -f app/src/fleet/campaign-setup.ts && test -f app/test/fleet-vault.test.ts && test -f app/test/fixtures/fleet-vault-v1.json && test -f app/test/fleet-setup.test.ts && npm run build:fleet && node --test dist-fleet/test/fleet/fee-charge.test.js dist-fleet/test/fleet/campaign-route.test.js && npm --prefix app run verify'
checksh fleet-buy "Fleet SDK and five-wallet sponsored-buy tests pass" \
  'test -f test/fleet/buy-route.test.ts && test -f test/fleet/sdk-policy.test.ts && test -f test/fleet/five-wallet-e2e.test.ts && test -f api/fleet/buy.js && test -f src/fleet/user-operation.ts && test -f src/fleet/sdk.ts && test -f app/src/fleet/control-room.ts && test -f app/test/fleet-buy.test.ts && npm run build:fleet && node --test dist-fleet/test/fleet/buy-route.test.js dist-fleet/test/fleet/sdk-policy.test.js dist-fleet/test/fleet/five-wallet-e2e.test.js && npm --prefix app run verify'
checksh fleet-control "Fleet terminal-revocation and owner-close tests pass" \
  'test -f test/fleet/control-route.test.ts && test -f test/fleet/campaign-state.test.ts && test -f test/fleet/sdk-policy.test.ts && test -f app/test/fleet-control-room.test.ts && test -f api/fleet/control.js && test -f app/src/fleet/control-room.ts && test -f src/fleet/sdk.ts && npm run build:fleet && node --test dist-fleet/test/fleet/control-route.test.js dist-fleet/test/fleet/campaign-state.test.js dist-fleet/test/fleet/sdk-policy.test.js && npm --prefix app run verify'
checksh fleet-acceptance "Fleet suite, build, privacy boundary, and quickstart coverage pass" \
  'test -f test/fleet/privacy-boundary.test.ts && test -f test/fleet/quickstart.test.ts && test -f app/test/fleet-acceptance.test.ts && test -f contracts/fleet/FleetAccountFactory.sol && test -f contracts/fleet/FleetSessionPolicy.sol && test -f contracts/fleet/FleetCampaignEscrow.sol && test -f specs/001-fleet-mission/quickstart.md && test -d app/src/fleet && test -d src/fleet && test -d api/fleet && test -d contracts/fleet && npm run build:fleet && node --test dist-fleet/test/fleet/*.test.js && npm --prefix app run verify && npm run build && ! grep -rqE "plaintext.{0,40}(owner|private).{0,40}key|fleet-wide unlinkability" app/src/fleet src/fleet api/fleet contracts/fleet'

# --- Stage 2: private funding pool (starts RED until built) --------------
# Predicates mirror specs/002-private-funding-pool/{tasks,quickstart}.md.
checksh pool-foundation "Pool contract, ledger, and ABI separation proven on the 46630 fork" \
  'test -f contracts/fleet/FleetPool.sol && test -f src/fleet/pool-ledger.ts && test -f src/fleet/chain-pool.ts && test -f test/fleet/pool-abi.test.ts && test -f test/fleet/pool-ledger.test.ts && test -f test/fork/fleet-pool.test.ts && test -f test/fork/fleet-pool-exit.test.ts && test -f test/fork/fleet-pool-draw.test.ts && grep -q "api/fleet/sweep" vercel.json && npm run build:fleet && node --test dist-fleet/test/fleet/pool-abi.test.js dist-fleet/test/fleet/pool-ledger.test.js dist-fleet/test/fleet/pool-throttle.test.js && npx hardhat compile && npm run build && node --test dist/test/fork/fleet-pool.test.js dist/test/fork/fleet-pool-exit.test.js dist/test/fork/fleet-pool-draw.test.js'
checksh pool-balance "Balance, headroom, withdrawal, and exit paths pass" \
  'test -f test/fleet/balance-route.test.ts && test -f app/test/fleet-balance.test.ts && test -f test/fork/fleet-pool-balance.test.ts && test -f api/fleet/balance.js && test -f app/balance.html && test -f app/src/balance-page.ts && npm run build:fleet && node --test dist-fleet/test/fleet/balance-route.test.js dist-fleet/test/fleet/pool-status-route.test.js && npm run build && node --test dist/test/fork/fleet-pool-balance.test.js && npm --prefix app run verify'
checksh pool-fund "Delayed funding from a fresh instance and just-in-time buys pass" \
  'test -f test/fleet/activate-draw-route.test.ts && test -f test/fork/fleet-pool-fund.test.ts && test -f app/test/fleet-activate-draw.test.ts && test -f src/fleet/pool-buy.ts && test -f api/fleet/sweep.js && npm run build:fleet && node --test dist-fleet/test/fleet/activate-draw-route.test.js && npm run build && node --test dist/test/fork/fleet-pool-fund.test.js && npm --prefix app run verify'
checksh fleet-trade "A seeded fleet order runs over two polls, every slice once; quote, list and holdings answer" \
  'test -f test/fleet/order-plan.test.ts && test -f test/fleet/market.test.ts && test -f test/fleet/order-route.test.ts && test -f test/fork/fleet-order.test.ts && test -f api/fleet/trade.js && npm run build:fleet && node --test dist-fleet/test/fleet/order-plan.test.js dist-fleet/test/fleet/market.test.js dist-fleet/test/fleet/order-route.test.js dist-fleet/test/fleet/store.test.js dist-fleet/test/fleet/store-neon.test.js dist-fleet/test/fleet/store-sharing.test.js && npm run build && node --test dist/test/fork/fleet-order.test.js'
checksh pool-lock "Two instances on one operator account sign one nonce at a time, and a lost lease broadcasts nothing" \
  'test -f test/fleet/operator-lock.test.ts && test -f test/fleet/store-lease.test.ts && test -f test/fork/fleet-two-instances.test.ts && npm run build:fleet && node --test dist-fleet/test/fleet/operator-lock.test.js dist-fleet/test/fleet/store-lease.test.js && npm run build && node --test dist/test/fork/fleet-two-instances.test.js'
checksh pool-control "Close-to-balance, top-up, and operator pause pass" \
  'test -f test/fleet/pool-control-route.test.ts && test -f test/fork/fleet-pool-control.test.ts && npm run build:fleet && node --test dist-fleet/test/fleet/pool-control-route.test.js && npm run build && node --test dist/test/fork/fleet-pool-control.test.js && npm --prefix app run verify'
checksh pool-acceptance "Observer unlinkability, FR-015 claims, and every Stage 1 gate green" \
  'test -f test/fork/fleet-pool-observer.test.ts && test -f app/test/fleet-claims.test.ts && test -f scripts/fleet-pool-deploy-live.ts && npm run build && node --test dist/test/fork/fleet-pool-observer.test.js && npm --prefix app run verify && (cd landing && npm run verify) && ! grep -rqiE "untraceable|unlinkab|no trail" app/fleet.html app/fleet-privacy.html app/balance.html app/fleet-dashboard.html landing/public/index.html && ./verify.sh fleet-evidence && ./verify.sh fleet-foundation && ./verify.sh fleet-create && ./verify.sh fleet-buy && ./verify.sh fleet-control && ./verify.sh fleet-acceptance && ./verify.sh fleet-venue'

# --- phase 3: brand, then one screen --------------------------------------
checksh phase-3 "brand truth names an accent hex"      'test -f brand/BRAND-TRUTH.md && grep -qE "#[0-9a-fA-F]{6}" brand/BRAND-TRUTH.md'
checksh phase-3 "favicon exists and is non-empty"      'test -s brand/favicon.svg'
# Must assert app/package.json, not just app/ — `npm run build` from an empty
# subdirectory walks up and runs the ROOT package.json's build script, which
# passes and tells you nothing.
checksh phase-3 "the app has its own package with a build script" \
  'test -f app/package.json && grep -qE "\"build\"[[:space:]]*:" app/package.json'
checksh phase-3 "the app builds and emits output" \
  'test -f app/package.json && (cd app && npm run build) && test -n "$(ls -A app/dist 2>/dev/null)"'

# --- phase 4: repo hygiene ---------------------------------------------------
checksh phase-4 "README documents a runnable setup"    'test -f README.md && grep -qiE "^#+ .*(install|setup|quick ?start|run)" README.md'
checksh phase-4 "no private key or API key committed" \
  'test -d contracts && ! grep -rqE "(BEGIN [A-Z ]*PRIVATE KEY|sk-[a-zA-Z0-9]{16}|0x[0-9a-fA-F]{64}\"?[[:space:]]*(#|//)?[[:space:]]*(private|deployer))" contracts/ scripts/ README.md'
checksh phase-4 ".env is not tracked by git" \
  'test -d .git && ! git ls-files --error-unmatch .env >/dev/null 2>&1'
checksh phase-4 "no assistant traces in the repo" \
  'test -f README.md && ! grep -rqiE "claude|anthropic|generated by ai|as an ai" README.md contracts/ 2>/dev/null'
checksh phase-4 "the build contract is tracked, not ignored" \
  'test -d .git && git ls-files --error-unmatch Goal.md plan.md prompt.md verify.sh >/dev/null 2>&1'

# --- the capped mainnet beta on 4663 (specs/003-mainnet-beta) ---
# These start RED. Each asserts the shape the beta needs, not that a file exists.

checksh beta-gate "CI runs the no-network set and nothing commits to main" \
  'test -f .github/workflows/verify-full.yml && test -f test/fleet/ci-workflows.test.ts && ! grep -q "contents: write" .github/workflows/progress.yml && ! grep -q "contents: write" .github/workflows/session-demo.yml'

checksh beta-caps "the caps live in the pool bytecode and the deploy script names an admin" \
  'test -f src/fleet/pool-caps.ts && grep -q "depositorCap_\|poolCap_" contracts/fleet/FleetPool.sol && grep -q "FLEET_ADMIN_ADDRESS" scripts/fleet-redeploy-live.ts && grep -qE "deploy\(\"FleetPool\", \[[a-zA-Z]+\.address, " scripts/fleet-redeploy-live.ts'

checksh beta-money "every money write signs, records its hash, then broadcasts, and no caller reads an exception as proof" \
  'grep -q "nextNonce" src/fleet/chain-pool.ts && grep -q "signAndBroadcast" src/fleet/chain-pool.ts && grep -q "resolve" src/fleet/chain-pool.ts && grep -qE "markSent|resolveSent" src/fleet/store.ts && grep -qE "markSent|resolveSent" src/fleet/store-neon.ts && ! grep -q "catch {}" src/fleet/pool-buy.ts && npm run build:fleet && node --test "dist-fleet/test/fleet/*.test.js"'

checksh beta-contract "the pool reimburses fronted withdrawals and an outsider can check it holds what it owes" \
  'grep -q "totalPosted" contracts/fleet/FleetPool.sol && grep -q "function donate" contracts/fleet/FleetPool.sol && grep -q "function postQueuedBatch" contracts/fleet/FleetPool.sol && grep -q "everDeposited" contracts/fleet/FleetPool.sol && grep -q "exitsPaid" contracts/fleet/FleetPool.sol && ! grep -q "invariant_claimableIsGasOnly" test/fleet/FleetPoolInvariants.t.sol && npx hardhat test solidity'

checksh beta-rails "the sweep has clocks, failures are counted, and the pool pauses itself" \
  'grep -q "blockTime" src/fleet/chain-def.ts && grep -q "maxDuration" vercel.json && grep -qE "multicall|Multicall3" src/fleet/chain-pool.ts && grep -qiE "alert" src/fleet/service-runtime.ts && grep -qiE "autopause|pauseOnTrigger|automatic pause" src/fleet/*.ts'

checksh beta-alerts "the service says what an outside reader cannot see, to the operator chat and not to the group" \
  'test -f src/fleet/alerts.ts && grep -q "MONITOR_CHAT_ID" src/fleet/alerts.ts && ! grep -q "TELEGRAM_CHAT_ID\"]" src/fleet/alerts.ts && ! grep -q "TELEGRAM_CHAT_ID" .github/workflows/sweep.yml && grep -q "if: failure()" .github/workflows/sweep.yml && grep -q "alerts" src/fleet/service-runtime.ts && npm run build:fleet && node --test dist-fleet/test/fleet/alerts.test.js dist-fleet/test/fleet/alert-routes.test.js dist-fleet/test/fleet/ci-workflows.test.js dist-fleet/test/fleet/store.test.js dist-fleet/test/fleet/store-neon.test.js'

checksh beta-surfaces "the gate, the beta note and the honest refusal are on the pages a depositor reads" \
  'test -f app/src/fleet/holders-gate.ts && grep -q "chain-target.json" app/build.mjs && grep -qiE "not been audited|unaudited" app/chain-target.mjs && grep -qiE "operator key can move|operator can move" app/chain-target.mjs && npm --prefix app run verify'

checksh beta-venue "every tradable token is pinned to its real pool and quoted against it" \
  'test -f src/fleet/token-registry.ts && test -f deployments/token-registry-4663.json && grep -q "poolId" deployments/token-registry-4663.json && grep -q "slippageBps" deployments/token-registry-4663.json && ! grep -q "venuePoolKey(token)" src/fleet/campaign-routes.ts && npm run build:fleet && node --test dist-fleet/test/fleet/v4-swap.test.js'

checksh beta-launch "no published sentence claims an audit precedes mainnet, and sells stay out" \
  'test -f README.md && ! grep -rqiE "audit (is )?(required |a )?(gate |precondition )?before (mainnet|real funds)" README.md ONBOARDING.md specs/002-private-funding-pool/spec.md web/components && grep -rqiE "capped|beta" web/components/scenes.tsx'

# --- manual checks (not automatable; confirm before calling the build done) ---
cat <<'MANUAL'

manual:
  [ ] GitHub repo is PUBLIC and a stranger can clone and follow the README
  [ ] Fleet Control Room makes public trades/shared paymaster and the private primary-to-fleet edge understandable
  [ ] Fleet activation and pause/revoke feedback respects reduced-motion preferences
  [ ] Fleet demo names a verified testnet route or clearly labels the test-only fixture
MANUAL

[ "$fail" -eq 0 ] || exit 1
