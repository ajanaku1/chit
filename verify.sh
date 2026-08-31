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
pass=0; fail=0; degraded=0; executed=0

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

# Canonical addresses, each confirmed live on Sepolia by eth_getCode during
# planning. If a deployment record disagrees with one of these, the deployment
# is wrong — not this list.
ENTRYPOINT=0x0000000071727De22E5E9d8BAf0edAc6f37da032
NOXCOMPUTE=0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF
FACTORY=0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985
RPC="${SEPOLIA_RPC_URL:-https://sepolia.drpc.org}"

# tx_field <file> <key> — echoes the 32-byte tx hash recorded at <key>, if any.
tx_field() {
  grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"0x[0-9a-fA-F]{64}\"" "$1" 2>/dev/null \
    | grep -oE '0x[0-9a-fA-F]{64}' | head -1
}

# tx_landed <file> <key> — true iff the hash recorded at <key> is a real Sepolia
# transaction whose receipt reports success.
#
# The grep checks above only prove a 64-hex STRING is present. A fabricated hash
# satisfies them, which would turn "no mock data" green on invented evidence.
# This asks the chain.
tx_landed() {
  local hash out
  hash="$(tx_field "$1" "$2")"
  [ -n "$hash" ] || return 1
  out=$(curl -s --max-time 25 -X POST "$RPC" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$hash\"]}" 2>/dev/null) || return 1
  printf '%s' "$out" | grep -qE '"status"[[:space:]]*:[[:space:]]*"0x1"'
}

# has_code <address> — true iff the address has bytecode on Sepolia.
has_code() {
  local out
  out=$(curl -s --max-time 20 -X POST "$RPC" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$1\",\"latest\"]}" 2>/dev/null) || return 1
  printf '%s' "$out" | grep -qE '"result"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{40,}"'
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
  for role in entryPoint paymaster router venue; do
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

address_field() {
  grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"0x[0-9a-fA-F]{40}\"" "$1" 2>/dev/null \
    | grep -oE '0x[0-9a-fA-F]{40}' | head -1
}

eth_call_result() {
  local out
  out=$(curl -s --max-time 25 -X POST "$RPC" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$1\",\"data\":\"$2\"},\"latest\"]}" 2>/dev/null) || return 1
  printf '%s' "$out" | jq -er '.result | select(type == "string")'
}

contract_word_equals() {
  local result
  result=$(eth_call_result "$1" "$2") || return 1
  [ "$result" = "0x$(printf '%064x' "$3")" ]
}

address_word() {
  printf '%064s' "${1#0x}" | tr ' A-F' '0a-f'
}

contract_address_equals() {
  local result expected
  result=$(eth_call_result "$1" "$2") || return 1
  expected="0x$(address_word "$3")"
  [ "$(printf '%s' "$result" | tr 'A-F' 'a-f')" = "$expected" ]
}

transaction_matches() {
  local hash response expected_value
  hash=$(tx_field "$1" "$2")
  [ -n "$hash" ] || return 1
  printf -v expected_value '0x%x' "$5"
  response=$(curl -s --max-time 25 -X POST "$RPC" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionByHash\",\"params\":[\"$hash\"]}" 2>/dev/null) || return 1
  printf '%s' "$response" | jq -e \
    --arg from "$(printf '%s' "$3" | tr 'A-F' 'a-f')" \
    --arg to "$(printf '%s' "$4" | tr 'A-F' 'a-f')" \
    --arg value "$expected_value" \
    '.result != null and (.result.from | ascii_downcase) == $from and (.result.to | ascii_downcase) == $to and .result.value == $value' \
    >/dev/null
}

low_stake_factory_deployment_matches() {
  local file hash creator factory transaction receipt
  file="$1"
  hash=$(tx_field "$file" factoryDeployTx)
  creator=$(address_field "$file" creator)
  factory=$(address_field "$file" factory)
  [ -n "$hash" ] && [ -n "$creator" ] && [ -n "$factory" ] || return 1
  transaction=$(curl -s --max-time 25 -X POST "$RPC" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionByHash\",\"params\":[\"$hash\"]}" 2>/dev/null) || return 1
  receipt=$(curl -s --max-time 25 -X POST "$RPC" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$hash\"]}" 2>/dev/null) || return 1
  printf '%s\n%s' "$transaction" "$receipt" | jq -s -e \
    --arg creator "$(printf '%s' "$creator" | tr 'A-F' 'a-f')" \
    --arg factory "$(printf '%s' "$factory" | tr 'A-F' 'a-f')" \
    '.[0].result.to == null and (.[0].result.from | ascii_downcase) == $creator and .[0].result.value == "0x0" and .[1].result.status == "0x1" and (.[1].result.contractAddress | ascii_downcase) == $factory' \
    >/dev/null
}

low_stake_round_matches() {
  local file factory round_id result expected
  file="$1"
  factory=$(address_field "$file" factory)
  round_id=$(grep -oE '"roundId"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{64}"' "$file" | grep -oE '0x[0-9a-fA-F]{64}' | head -1)
  [ -n "$factory" ] && [ -n "$round_id" ] || return 1
  result=$(eth_call_result "$factory" "0xdd2be61d${round_id#0x}") || return 1
  expected="0x$(address_word "$(address_field "$file" creator)")"
  expected="${expected}$(address_word "$(address_field "$file" operator)")"
  expected="${expected}$(address_word "$(address_field "$file" verifier)")"
  expected="${expected}$(address_word "$(address_field "$file" auditor)")"
  expected="${expected}$(address_word "$(address_field "$file" vault)")"
  expected="${expected}$(address_word "$(address_field "$file" settlement)")"
  expected="${expected}$(address_word "$(address_field "$file" paymaster)")"
  expected="${expected}$(printf '%064x' 31)"
  [ "$(printf '%s' "$result" | tr 'A-F' 'a-f')" = "$expected" ]
}

low_stake_stake_matches() {
  local file paymaster result expected
  file="$1"
  paymaster=$(address_field "$file" paymaster)
  result=$(eth_call_result "$paymaster" 0x8cc01fdc) || return 1
  expected="0x$(printf '%064x' 100000000000000000)"
  expected="${expected}$(printf '%064x' 86400)"
  expected="${expected}$(printf '%064x' 1)"
  [ "$result" = "$expected" ]
}

active_sponsor_state_matches() {
  local file vault sponsor handle result argument
  file="$1"
  vault=$(address_field "$file" vault)
  sponsor=$(address_field "$file" sponsor)
  handle=$(grep -oE '"budgetHandle"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{64}"' "$file" \
    | grep -oE '0x[0-9a-fA-F]{64}' | head -1)
  [ -n "$vault" ] && [ -n "$sponsor" ] && [ -n "$handle" ] || return 1
  argument=$(address_word "$sponsor")
  contract_word_equals "$vault" "0x8a6cde48$argument" 1 || return 1
  contract_word_equals "$vault" 0xe90abf41 1 || return 1
  contract_address_equals "$vault" \
    0xcfe357440000000000000000000000000000000000000000000000000000000000000000 \
    "$sponsor" || return 1
  result=$(eth_call_result "$vault" \
    0x1bef5e020000000000000000000000000000000000000000000000000000000000000000) || return 1
  [ "$(printf '%s' "$result" | tr 'A-F' 'a-f')" = "$(printf '%s' "$handle" | tr 'A-F' 'a-f')" ]
}

active_sponsor_transaction_matches() {
  local file vault sponsor hash response
  file="$1"
  vault=$(address_field "$file" vault)
  sponsor=$(address_field "$file" sponsor)
  hash=$(tx_field "$file" registrationTx)
  transaction_matches "$file" registrationTx "$sponsor" "$vault" 0 || return 1
  response=$(curl -s --max-time 25 -X POST "$RPC" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionByHash\",\"params\":[\"$hash\"]}" 2>/dev/null) || return 1
  printf '%s' "$response" | jq -e '.result.input | startswith("0x57844129")' >/dev/null
}

active_sponsor_event_matches() {
  local file vault sponsor hash response sponsor_topic slot_topic
  file="$1"
  vault=$(address_field "$file" vault)
  sponsor=$(address_field "$file" sponsor)
  hash=$(tx_field "$file" registrationTx)
  sponsor_topic="0x$(address_word "$sponsor")"
  slot_topic="0x$(printf '%064x' 0)"
  response=$(curl -s --max-time 25 -X POST "$RPC" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$hash\"]}" 2>/dev/null) || return 1
  printf '%s' "$response" | jq -e \
    --arg vault "$(printf '%s' "$vault" | tr 'A-F' 'a-f')" \
    --arg sponsor "$sponsor_topic" --arg slot "$slot_topic" \
    '.result.status == "0x1" and any(.result.logs[]; (.address | ascii_downcase) == $vault and .topics[0] == "0x0824025c035a6f7d44ebc90039c109d76c083a5e5ac9d9c8a494fa1f0faba141" and .topics[1] == $sponsor and .topics[2] == $slot)' \
    >/dev/null
}

active_sponsor_handle_resolved() {
  local handle response
  handle=$(grep -oE '"budgetHandle"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{64}"' \
    "$1" | grep -oE '0x[0-9a-fA-F]{64}' | head -1)
  [ -n "$handle" ] || return 1
  response=$(curl -s --max-time 25 https://gateway-testnets.noxprotocol.dev/v0/public/handles/status \
    -H 'content-type: application/json' --data "{\"handles\":[\"$handle\"]}") || return 1
  printf '%s' "$response" | jq -e --arg handle "$handle" \
    '.payload.statuses[] | select((.handle | ascii_downcase) == ($handle | ascii_downcase) and .resolved == true)' >/dev/null
}

factory_gate_stake_matches() {
  local paymaster argument result expected
  paymaster=$(address_field deployments/factory-browser-gate.json paymaster)
  [ -n "$paymaster" ] || return 1
  argument=$(printf '%064s' "${paymaster#0x}" | tr ' ' 0)
  result=$(eth_call_result "$ENTRYPOINT" "0x5287ce12$argument") || return 1
  expected="0x000000000000000000000000000000000000000000000000002386f26fc10000"
  expected="${expected}0000000000000000000000000000000000000000000000000000000000000001"
  expected="${expected}0000000000000000000000000000000000000000000000000de0b6b3a7640000"
  expected="${expected}0000000000000000000000000000000000000000000000000000000000015180"
  expected="${expected}0000000000000000000000000000000000000000000000000000000000000000"
  [ "$result" = "$expected" ]
}

factory_gate_sponsor_matches() {
  local vault sponsor expected result
  vault=$(address_field deployments/factory-browser-gate.json vault)
  sponsor=$(address_field deployments/factory-browser-gate.json sponsor)
  [ -n "$vault" ] && [ -n "$sponsor" ] || return 1
  expected="0x$(printf '%064s' "${sponsor#0x}" | tr ' ' 0)"
  result=$(eth_call_result "$vault" \
    0xcfe357440000000000000000000000000000000000000000000000000000000000000000) || return 1
  [ "$(printf '%s' "$result" | tr 'A-F' 'a-f')" = "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" ]
}

factory_gate_handle_resolved() {
  local handle response
  handle=$(grep -oE '"budgetHandle"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{64}"' \
    deployments/factory-browser-gate.json | grep -oE '0x[0-9a-fA-F]{64}' | head -1)
  [ -n "$handle" ] || return 1
  response=$(curl -s --max-time 25 https://gateway-testnets.noxprotocol.dev/v0/public/handles/status \
    -H 'content-type: application/json' --data "{\"handles\":[\"$handle\"]}") || return 1
  printf '%s' "$response" | jq -e --arg handle "$handle" \
    '.payload.statuses[] | select((.handle | ascii_downcase) == ($handle | ascii_downcase) and .resolved == true)' >/dev/null
}

factory_gate_handle_matches_vault() {
  local vault handle result
  vault=$(address_field deployments/factory-browser-gate.json vault)
  handle=$(grep -oE '"budgetHandle"[[:space:]]*:[[:space:]]*"0x[0-9a-fA-F]{64}"' \
    deployments/factory-browser-gate.json | grep -oE '0x[0-9a-fA-F]{64}' | head -1)
  [ -n "$vault" ] && [ -n "$handle" ] || return 1
  result=$(eth_call_result "$vault" \
    0x1bef5e020000000000000000000000000000000000000000000000000000000000000000) || return 1
  [ "$(printf '%s' "$result" | tr 'A-F' 'a-f')" = "$(printf '%s' "$handle" | tr 'A-F' 'a-f')" ]
}

echo "== Chit verify =="

# --- phase 0: the three things a fork provably cannot prove -----------------
check   phase-0 "Nox handle gateway is reachable" \
  sh -c 'curl -sf --max-time 15 https://gateway-testnets.noxprotocol.dev/ | grep -q "Handle Gateway"'
checksh phase-0 "live fromExternal import recorded" \
  'test -f deployments/phase0-live.json && grep -qE "\"fromExternalTx\"[[:space:]]*:[[:space:]]*\"0x[0-9a-fA-F]{64}\"" deployments/phase0-live.json'
check   phase-0 "that fromExternal tx really landed on Sepolia" \
  tx_landed deployments/phase0-live.json fromExternalTx
checksh phase-0 "gateway resolved a live-Sepolia handle" \
  'test -f deployments/phase0-live.json && grep -qE "\"handleResolved\"[[:space:]]*:[[:space:]]*true" deployments/phase0-live.json'
checksh phase-0 "auditor decryption succeeded, non-auditor denied" \
  'test -f deployments/phase0-live.json && grep -qE "\"auditorDecrypt\"[[:space:]]*:[[:space:]]*true" deployments/phase0-live.json && grep -qE "\"nonAuditorDenied\"[[:space:]]*:[[:space:]]*true" deployments/phase0-live.json'

# --- phase 1: contracts, test-first ----------------------------------------
check   phase-1 "contracts compile"                    npx hardhat compile
check   phase-1 "test suite passes"                    npx hardhat test
checksh phase-1 "an oblivious-debit test exists"       'test -d test && grep -rqi "oblivious" test/'
checksh phase-1 "a pro-rata settlement test exists"    'test -d test && grep -rqiE "pro-?rata|haircut" test/'
checksh phase-1 "no TODO left in contracts"            'test -d contracts && ! grep -rq "TODO" contracts/'
checksh phase-1 "no new npm dependency added"          'test -f package.json && ! grep -q "@account-abstraction/contracts" package.json'

# --- phase 2: deployed, and the real journey landed ------------------------
checksh phase-2 "deployment record pins canonical EntryPoint" \
  "test -f deployments/sepolia.json && grep -iq '$ENTRYPOINT' deployments/sepolia.json"
checksh phase-2 "deployment record pins canonical NoxCompute" \
  "test -f deployments/sepolia.json && grep -iq '$NOXCOMPUTE' deployments/sepolia.json"
checksh phase-2 "deployment record pins canonical account factory" \
  "test -f deployments/sepolia.json && grep -iq '$FACTORY' deployments/sepolia.json"
check   phase-2 "canonical EntryPoint really has code on Sepolia"  has_code "$ENTRYPOINT"
check   phase-2 "canonical NoxCompute really has code on Sepolia"  has_code "$NOXCOMPUTE"
checksh phase-2 "deployed ChitPaymaster has code on Sepolia" \
  'addr=$(grep -oE "\"chitPaymaster\"[[:space:]]*:[[:space:]]*\"0x[0-9a-fA-F]{40}\"" deployments/sepolia.json 2>/dev/null | grep -oE "0x[0-9a-fA-F]{40}"); test -n "$addr" && curl -s --max-time 20 -X POST "${SEPOLIA_RPC_URL:-https://sepolia.drpc.org}" -H "content-type: application/json" --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$addr\",\"latest\"]}" | grep -qE "\"result\"[[:space:]]*:[[:space:]]*\"0x[0-9a-fA-F]{40,}\""'
checksh phase-2 "a real sponsored UserOperation tx is recorded" \
  'test -f deployments/sepolia.json && grep -qE "\"sponsoredUserOpTx\"[[:space:]]*:[[:space:]]*\"0x[0-9a-fA-F]{64}\"" deployments/sepolia.json'
check   phase-2 "that sponsored UserOperation tx really landed on Sepolia" \
  tx_landed deployments/sepolia.json sponsoredUserOpTx
checksh phase-2 "an epoch settlement tx is recorded" \
  'test -f deployments/sepolia.json && grep -qE "\"settleEpochTx\"[[:space:]]*:[[:space:]]*\"0x[0-9a-fA-F]{64}\"" deployments/sepolia.json'
check   phase-2 "that epoch settlement tx really landed on Sepolia" \
  tx_landed deployments/sepolia.json settleEpochTx

# --- factory gate: staged public round and reference-bundler stake ----------
FACTORY_GATE=deployments/factory-browser-gate.json
checksh factory-gate "factory browser-gate record exists" \
  'test -f deployments/factory-browser-gate.json'
for key in factory vault settlement paymaster; do
  check factory-gate "$key has code on Sepolia" \
    has_code "$(address_field "$FACTORY_GATE" "$key")"
done
for key in factoryDeployTx beginRoundTx activationTx sponsorCollateralTx sponsorRegistrationTx 0 1 2 3 4; do
  check factory-gate "$key transaction landed on Sepolia" \
    tx_landed "$FACTORY_GATE" "$key"
done
check factory-gate "factory-created vault is active" \
  contract_word_equals "$(address_field "$FACTORY_GATE" vault)" 0x02fb0c5e 1
check factory-gate "factory-created paymaster is active" \
  contract_word_equals "$(address_field "$FACTORY_GATE" paymaster)" 0xe0ba8cea 1
check factory-gate "EntryPoint holds the declared deposit, stake, and delay" \
  factory_gate_stake_matches
check factory-gate "admitted Rabby wallet occupies sponsor slot zero" \
  factory_gate_sponsor_matches
check factory-gate "recorded confidential handle is stored in the vault" \
  factory_gate_handle_matches_vault
check factory-gate "registered confidential handle resolved at the Nox gateway" \
  factory_gate_handle_resolved

# --- low-stake recovery: service-wired round without the old 1 ETH lock -----
LOW_STAKE=deployments/low-stake-round.json
checksh low-stake "low-stake deployment evidence exists" \
  'test -f deployments/low-stake-round.json'
for key in factory coreDeployer vault settlement paymaster; do
  check low-stake "$key has code on Sepolia" \
    has_code "$(address_field "$LOW_STAKE" "$key")"
done
for key in factoryDeployTx beginRoundTx activationTx 0 1 2 3 4; do
  check low-stake "$key transaction landed on Sepolia" \
    tx_landed "$LOW_STAKE" "$key"
done
check low-stake "factory deployment came from the creator" \
  low_stake_factory_deployment_matches "$LOW_STAKE"
check low-stake "factory minimum stake is exactly 0.1 ETH" \
  contract_word_equals "$(address_field "$LOW_STAKE" factory)" 0xec5ffac2 100000000000000000
check low-stake "factory round tuple has exact roles, children, and five initialized steps" \
  low_stake_round_matches "$LOW_STAKE"
check low-stake "activation transferred exactly 0.111 ETH from creator to factory" \
  transaction_matches "$LOW_STAKE" activationTx \
    "$(address_field "$LOW_STAKE" creator)" "$(address_field "$LOW_STAKE" factory)" 111000000000000000
check low-stake "vault is active" \
  contract_word_equals "$(address_field "$LOW_STAKE" vault)" 0x02fb0c5e 1
check low-stake "paymaster round is active" \
  contract_word_equals "$(address_field "$LOW_STAKE" paymaster)" 0xe0ba8cea 1
check low-stake "paymaster operator is the service address" \
  contract_address_equals "$(address_field "$LOW_STAKE" paymaster)" 0x570ca735 \
    "$(address_field "$LOW_STAKE" operator)"
check low-stake "paymaster verifier is the service address" \
  contract_address_equals "$(address_field "$LOW_STAKE" paymaster)" 0x2b7ac3f3 \
    "$(address_field "$LOW_STAKE" verifier)"
check low-stake "settlement operator is the service address" \
  contract_address_equals "$(address_field "$LOW_STAKE" settlement)" 0x570ca735 \
    "$(address_field "$LOW_STAKE" operator)"
check low-stake "EntryPoint deposit is exactly 0.01 ETH" \
  contract_word_equals "$(address_field "$LOW_STAKE" paymaster)" 0x57779894 10000000000000000
check low-stake "EntryPoint stake is 0.1 ETH with a one-day delay" \
  low_stake_stake_matches "$LOW_STAKE"

# --- active sponsor: previous wallet admitted to the low-stake vault --------
ACTIVE_SPONSOR=deployments/active-sponsor.json
checksh active-sponsor "active sponsor evidence exists" \
  'test -f deployments/active-sponsor.json'
checksh active-sponsor "evidence is pinned to the low-stake round and 1,000-unit slot-zero budget" \
  'jq -s -e '\''.[0].chainId == 11155111 and .[0].roundId == .[1].roundId and .[0].vault == .[1].vault and .[0].chitBudgetToken == .[1].wrapper and .[0].slot == 0 and .[0].budgetBaseUnits == "1000" and .[0].handleResolved == true'\'' deployments/active-sponsor.json deployments/low-stake-round.json >/dev/null'
check active-sponsor "registration transaction landed on Sepolia" \
  tx_landed "$ACTIVE_SPONSOR" registrationTx
check active-sponsor "registration call came from the sponsor to the active vault" \
  active_sponsor_transaction_matches "$ACTIVE_SPONSOR"
check active-sponsor "registration event assigns the sponsor to slot zero" \
  active_sponsor_event_matches "$ACTIVE_SPONSOR"
check active-sponsor "live vault stores the sponsor and nonzero confidential handle" \
  active_sponsor_state_matches "$ACTIVE_SPONSOR"
check active-sponsor "registered confidential handle resolved at the Nox gateway" \
  active_sponsor_handle_resolved "$ACTIVE_SPONSOR"

# --- Fleet Mission: isolated testnet acceptance family ----------------------
# These checks are intentionally red until the T001–T041 slice exists. They
# Fixture/scaffold checks make no network call; live mode uses only bounded configured RPC after guards.
check fleet-evidence "Fleet dependency evidence or labelled fixture is tested" fleet_evidence_check
checksh fleet-foundation "Fleet foundation outputs and tests pass" \
  'test -f contracts/fleet/FleetAccountFactory.sol && test -f contracts/fleet/FleetSessionPolicy.sol && test -f contracts/fleet/FleetCampaignEscrow.sol && test -f src/fleet/campaign-service.ts && test -f test/fleet/campaign-state.test.ts && test -f test/fleet/session-policy.test.ts && test -f test/fleet/campaign-budget.test.ts && test -f test/fleet/campaign-service.test.ts && test -f test/fork/fleet-contracts.test.ts && npm run build:fleet && node --test dist-fleet/test/fleet/campaign-state.test.js dist-fleet/test/fleet/session-policy.test.js dist-fleet/test/fleet/campaign-budget.test.js dist-fleet/test/fleet/campaign-service.test.js && npx hardhat compile && npm run build && node --test dist/test/fork/fleet-contracts.test.js dist/test/fork/fleet-deploy.test.js'
checksh fleet-create "Fleet CHIT fee and local-vault creation tests pass" \
  'test -f specs/001-fleet-mission/contracts/fleet-vault.md && test -f test/fleet/fee-charge.test.ts && test -f test/fleet/campaign-route.test.ts && test -f src/fleet/eligibility.ts && test -f api/fleet/campaign.ts && test -f app/src/fleet/vault.ts && test -f app/src/fleet/campaign-setup.ts && test -f app/test/fleet-vault.test.ts && test -f app/test/fixtures/fleet-vault-v1.json && test -f app/test/fleet-setup.test.ts && npm run build:fleet && node --test dist-fleet/test/fleet/fee-charge.test.js dist-fleet/test/fleet/campaign-route.test.js && npm --prefix app run verify'
checksh fleet-buy "Fleet SDK and five-wallet sponsored-buy tests pass" \
  'test -f test/fleet/buy-route.test.ts && test -f test/fleet/sdk-policy.test.ts && test -f test/fleet/five-wallet-e2e.test.ts && test -f api/fleet/buy.ts && test -f src/fleet/user-operation.ts && test -f src/fleet/sdk.ts && test -f app/src/fleet/control-room.ts && test -f app/test/fleet-buy.test.ts && npm run build:fleet && node --test dist-fleet/test/fleet/buy-route.test.js dist-fleet/test/fleet/sdk-policy.test.js dist-fleet/test/fleet/five-wallet-e2e.test.js && npm --prefix app run verify'
checksh fleet-control "Fleet terminal-revocation and owner-close tests pass" \
  'test -f test/fleet/control-route.test.ts && test -f test/fleet/campaign-state.test.ts && test -f test/fleet/sdk-policy.test.ts && test -f app/test/fleet-control-room.test.ts && test -f api/fleet/control.ts && test -f app/src/fleet/control-room.ts && test -f src/fleet/sdk.ts && npm run build:fleet && node --test dist-fleet/test/fleet/control-route.test.js dist-fleet/test/fleet/campaign-state.test.js dist-fleet/test/fleet/sdk-policy.test.js && npm --prefix app run verify'
checksh fleet-acceptance "Fleet suite, build, privacy boundary, and quickstart coverage pass" \
  'test -f test/fleet/privacy-boundary.test.ts && test -f test/fleet/quickstart.test.ts && test -f app/test/fleet-acceptance.test.ts && test -f contracts/fleet/FleetAccountFactory.sol && test -f contracts/fleet/FleetSessionPolicy.sol && test -f contracts/fleet/FleetCampaignEscrow.sol && test -f specs/001-fleet-mission/quickstart.md && test -d app/src/fleet && test -d src/fleet && test -d api/fleet && test -d contracts/fleet && npm run build:fleet && node --test dist-fleet/test/fleet/*.test.js && npm --prefix app run verify && npm run build && ! grep -rqE "plaintext.{0,40}(owner|private).{0,40}key|fleet-wide unlinkability" app/src/fleet src/fleet api/fleet contracts/fleet'

# --- phase 3: brand, then one screen --------------------------------------
checksh phase-3 "brand truth names an accent hex"      'test -f brand/BRAND-TRUTH.md && grep -qE "#[0-9a-fA-F]{6}" brand/BRAND-TRUTH.md'
checksh phase-3 "favicon exists and is non-empty"      'test -s brand/favicon.svg'
checksh phase-3 "exactly two UI proposals exist"       'test "$(ls proposals/option-*.html 2>/dev/null | wc -l | tr -d " ")" = "2"'
checksh phase-3 "the selected direction is recorded"   'grep -rqiE "selected (direction|option)" IMPLEMENTATION.md 2>/dev/null'
# Must assert app/package.json, not just app/ — `npm run build` from an empty
# subdirectory walks up and runs the ROOT package.json's build script, which
# passes and tells you nothing.
checksh phase-3 "the app has its own package with a build script" \
  'test -f app/package.json && grep -qE "\"build\"[[:space:]]*:" app/package.json'
checksh phase-3 "the app builds and emits output" \
  'test -f app/package.json && (cd app && npm run build) && test -n "$(ls -A app/dist 2>/dev/null)"'

# --- phase 4: submission ---------------------------------------------------
checksh phase-4 "README documents a runnable setup"    'test -f README.md && grep -qiE "^#+ .*(install|setup|quick ?start|run)" README.md'
checksh phase-4 "README carries the narrow privacy claim" \
  'test -f README.md && grep -qi "privately attributes authorized gas sponsorship" README.md'
checksh phase-4 "README does NOT carry the overclaim" \
  'test -f README.md && ! grep -qiE "trustless(ly)? enforce|enforces? (each )?sponsor.s confidential budget" README.md'
checksh phase-4 "README states the public/private boundary" \
  'test -f README.md && grep -qi "private" README.md && grep -qi "public" README.md && grep -qi "trusted" README.md'
checksh phase-4 "README lists the live Sepolia addresses" \
  "test -f README.md && grep -iq '$ENTRYPOINT' README.md"
checksh phase-4 "feedback.md holds at least 8 dated findings" \
  'test -f feedback.md && [ "$(grep -cE "20[0-9]{2}-[0-9]{2}-[0-9]{2}" feedback.md)" -ge 8 ]'
checksh phase-4 "no private key or API key committed" \
  'test -d contracts && ! grep -rqE "(BEGIN [A-Z ]*PRIVATE KEY|sk-[a-zA-Z0-9]{16}|0x[0-9a-fA-F]{64}\"?[[:space:]]*(#|//)?[[:space:]]*(private|deployer))" contracts/ scripts/ README.md feedback.md'
checksh phase-4 ".env is not tracked by git" \
  'test -d .git && ! git ls-files --error-unmatch .env >/dev/null 2>&1'
checksh phase-4 "no assistant traces in the repo" \
  'test -f README.md && ! grep -rqiE "claude|anthropic|generated by ai|as an ai" README.md feedback.md contracts/ 2>/dev/null'
checksh phase-4 "scaffolding files are gitignored" \
  'test -f .gitignore && grep -q "^/prompt.md$" .gitignore && grep -q "^/Goal.md$" .gitignore && grep -q "^/plan.md$" .gitignore'
checksh phase-4 "demo video is at most 4:00" \
  'f=$(ls submission/demo.mp4 2>/dev/null | head -1); test -n "$f" && command -v ffprobe >/dev/null && d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f" | cut -d. -f1) && [ "$d" -le 240 ]'

# --- cross-check: a verifier that saw neither the plan nor the draft ---------
# Codex, read-only, judging contracts/ against privacy-boundary.done-when.md.
# This catches the one class of defect every grep above is blind to: code that
# passes string checks while quietly breaking the privacy claim we ship.
#
# Deliberately NOT inside check(): that harness sends stdout to /dev/null, and
# here the per-clause reasons are the entire value. Opt-in, because it is a paid
# network call — run it at phase boundaries, not on every inner-loop run.
#
#   ./verify.sh cross        only the cross-check
#   CROSS_CHECK=1 ./verify.sh   everything, cross-check included
CROSS_CHECK_BIN="${CROSS_CHECK_BIN:-$(cd "$(dirname "$0")/.." && pwd)/loop/guardrails/cross-check.sh}"
if [ "$FILTER" = "cross" ] || [ "${CROSS_CHECK:-}" = "1" ]; then
  executed=$((executed + 1))
  echo
  if [ ! -x "$CROSS_CHECK_BIN" ]; then
    printf '  FAIL  [cross] cross-check.sh not executable at %s\n' "$CROSS_CHECK_BIN"
    fail=$((fail + 1))
  else
    "$CROSS_CHECK_BIN" "$(dirname "$0")/privacy-boundary.done-when.md" \
      --dir "$(dirname "$0")" --task chit-privacy-boundary
    case $? in
      0) printf '  PASS  [cross] privacy boundary holds in contracts/\n'; pass=$((pass + 1)) ;;
      1) printf '  FAIL  [cross] privacy boundary violated in contracts/\n'; fail=$((fail + 1)) ;;
      # 3 = the peer verifier is genuinely absent. Self-assessment is the
      # sanctioned fallback, so this does not fail the gate -- but it is NOT a
      # cross-check, and must never be mistaken for one when reading output.
      3) printf '  DEGRADED  [cross] no independent verifier available; self-report stands\n'
         degraded=$((degraded + 1)) ;;
      # 2 = the verifier ran and produced nothing. An infra problem must never
      # read as a green gate, and must never license self-marking either.
      *) printf '  FAIL  [cross] verifier could not run (infra, not a verdict)\n'; fail=$((fail + 1)) ;;
    esac
  fi
fi

echo
if [ "$executed" -eq 0 ]; then
  printf '  FAIL  [filter] no checks matched "%s"; executed 0 predicates\n' "$FILTER"
  fail=$((fail + 1))
fi
printf 'passed %d, failed %d\n' "$pass" "$fail"
if [ "$degraded" -gt 0 ]; then
  printf 'DEGRADED: %d check(s) fell back to self-assessment because no independent\n' "$degraded"
  printf '          verifier was reachable. This is not a cross-checked pass.\n'
fi

# --- manual checks (not automatable; confirm before calling the build done) ---
cat <<'MANUAL'

manual:
  [ ] Deadline hour confirmed in the iExec Discord (date is triangulated, not official)
  [ ] X post published, tagging @iEx_ec, carrying description + video + repo link
  [ ] GitHub repo is PUBLIC and a stranger can clone and follow the README
  [ ] Video actually shows the ciphertext on a block explorer, not a screenshot of a UI
  [ ] Nothing on the judged path uses mock data
  [ ] Repo is clean-room; no reuse of a prior iExec VIBE Coding project
  [ ] The narrow privacy claim is what the video says out loud, not just what the README says
  [ ] Fleet Control Room makes public trades/shared paymaster and the private primary-to-fleet edge understandable
  [ ] Fleet activation and pause/revoke feedback respects reduced-motion preferences
  [ ] Fleet demo names a verified testnet route or clearly labels the test-only fixture
MANUAL

[ "$fail" -eq 0 ] || exit 1
