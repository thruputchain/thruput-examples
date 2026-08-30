#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:-$(command -v groundhog || true)}"
devnode_binary="${GROUNDHOG_DEVNODE_BINARY:-$(command -v hog-devnode || true)}"
default_artifacts_dir="$(cd "$(dirname "$devnode_binary")/../.." 2>/dev/null && pwd)/built_contracts"
contract_artifacts_dir="${GROUNDHOG_CONTRACT_ARTIFACTS_DIR:-$default_artifacts_dir}"
environment_path="$app_dir/.env.local"
dev_server="${GAME_OF_LIFE_DEV_SERVER:-0}"
node_pid=""
devnode_pid=""
indexer_pid=""
vite_pid=""
had_environment=0
generated_environment_fingerprint=""
initial_environment_fingerprint=""
received_signal=0

if [[ "$dev_server" != "0" && "$dev_server" != "1" ]]; then
  printf 'GAME_OF_LIFE_DEV_SERVER must be 0 or 1.\n' >&2
  exit 1
fi

if [[ -z "$groundhog_cli" || ! -x "$groundhog_cli" ]]; then
  printf 'Set GROUNDHOG_CLI to an executable Groundhog CLI.\n' >&2
  exit 1
fi
if [[ -z "$devnode_binary" || ! -x "$devnode_binary" ]]; then
  printf 'Set GROUNDHOG_DEVNODE_BINARY to an executable hog-devnode.\n' >&2
  exit 1
fi
if [[ ! -d "$contract_artifacts_dir" ]]; then
  printf 'Set GROUNDHOG_CONTRACT_ARTIFACTS_DIR to the devnode contract artifact directory.\n' >&2
  exit 1
fi
if [[ ! -f "$contract_artifacts_dir/dev_wallet.rv32a" ]]; then
  printf 'The contract artifact directory does not contain dev_wallet.rv32a.\n' >&2
  exit 1
fi
if [[ "$dev_server" == "0" ]] && ! command -v sqlite3 >/dev/null; then
  printf 'sqlite3 is required for durable restart verification.\n' >&2
  exit 1
fi
if ! command -v flock >/dev/null; then
  printf 'flock is required to serialize local environment updates.\n' >&2
  exit 1
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/groundhog-life-e2e.XXXXXX")"
export XDG_CONFIG_HOME="$work_dir/config"
export XDG_CACHE_HOME="$work_dir/cache"
devnode_pid_file="$XDG_CACHE_HOME/groundhog/hog-devnode.pid"
exec 9>"$app_dir/.env.local.lock"
if ! flock -n 9; then
  printf 'Another Game of Life setup or acceptance run owns .env.local.\n' >&2
  rm -rf "$work_dir"
  exit 1
fi
export GAME_OF_LIFE_ENV_LOCK_HELD=1
node_output="$work_dir/node.json"
node_log="$work_dir/node.log"
indexer_log="$work_dir/indexer.log"
vite_log="$work_dir/vite.log"
environment_backup="$work_dir/env.local"
evidence_dir="$app_dir/benchmark-results"
browser_evidence="$evidence_dir/phase-7-browser.json"
run_evidence="$evidence_dir/phase-7-clean-ledger.json"

stop_process() {
  local pid="$1"
  local expected_executable="${2:-}"
  local actual_executable=""
  local process_group=""
  if [[ -n "$expected_executable" ]]; then
    actual_executable="$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)"
    process_group="$(ps -o pgid= -p "$pid" 2>/dev/null || true)"
    process_group="${process_group//[[:space:]]/}"
    if [[ "$actual_executable" != "$(readlink -f "$expected_executable")" || "$process_group" != "$pid" ]]; then
      return
    fi
  fi
  if [[ -n "$pid" ]] && kill -0 -- "-$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for (( attempt = 0; attempt < 50; attempt += 1 )); do
      kill -0 -- "-$pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 -- "-$pid" 2>/dev/null; then
      process_group="$(ps -o pgid= -p "$pid" 2>/dev/null || true)"
      process_group="${process_group//[[:space:]]/}"
      if [[ -z "$expected_executable" || ( "$(readlink -f "/proc/$pid/exe" 2>/dev/null || true)" == "$(readlink -f "$expected_executable")" && "$process_group" == "$pid" ) ]]; then
        kill -KILL -- "-$pid" 2>/dev/null || true
      fi
    fi
    wait "$pid" 2>/dev/null || true
  fi
}

capture_devnode_pid() {
  if [[ -n "$devnode_pid" || ! -f "$devnode_pid_file" ]]; then
    return
  fi
  local candidate=""
  IFS= read -r candidate <"$devnode_pid_file" || true
  if [[ ! "$candidate" =~ ^[1-9][0-9]*$ ]]; then
    return
  fi
  local actual_executable=""
  actual_executable="$(readlink -f "/proc/$candidate/exe" 2>/dev/null || true)"
  if [[ "$actual_executable" == "$(readlink -f "$devnode_binary")" ]]; then
    devnode_pid="$candidate"
  fi
}

cleanup() {
  local exit_code=$?
  capture_devnode_pid
  stop_process "$devnode_pid" "$devnode_binary"
  stop_process "$node_pid"
  stop_process "$vite_pid"
  stop_process "$indexer_pid"
  current_fingerprint=""
  if [[ -f "$environment_path" && ! -L "$environment_path" ]]; then
    current_fingerprint="$(sha256sum "$environment_path")"
    current_fingerprint="${current_fingerprint%%[[:space:]]*}"
  fi
  expected_fingerprint="$generated_environment_fingerprint"
  if [[ -z "$expected_fingerprint" ]]; then
    expected_fingerprint="$initial_environment_fingerprint"
  fi
  if [[ "$current_fingerprint" == "$expected_fingerprint" ]]; then
    if (( had_environment == 1 )); then
      cp -p "$environment_backup" "$environment_path"
    else
      rm -f "$environment_path"
    fi
  else
    printf 'Preserving .env.local because it changed while the local stack was running.\n' >&2
  fi
  if (( exit_code != 0 && received_signal == 0 )); then
    for log in "$node_log" "$indexer_log" "$vite_log"; do
      if [[ -s "$log" ]]; then
        printf '\n%s:\n' "$(basename "$log")" >&2
        while IFS= read -r line; do printf '  %s\n' "$line" >&2; done < "$log"
      fi
    done
  fi
  rm -rf "$work_dir"
  exit "$exit_code"
}

if [[ -L "$environment_path" || -L "$evidence_dir" ]]; then
  printf 'Refusing symlinked local environment or evidence paths.\n' >&2
  rm -rf "$work_dir"
  exit 1
fi
if [[ -f "$environment_path" ]]; then
  cp -p "$environment_path" "$environment_backup"
  had_environment=1
  initial_environment_fingerprint="$(sha256sum "$environment_path")"
  initial_environment_fingerprint="${initial_environment_fingerprint%%[[:space:]]*}"
fi

trap cleanup EXIT
trap 'received_signal=1; exit 129' HUP
trap 'received_signal=1; exit 130' INT
trap 'received_signal=1; exit 143' TERM

free_port() {
  node -e 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>{process.stdout.write(String(server.address().port));server.close();});'
}

millis() {
  date +%s%3N
}

if [[ "$dev_server" == "1" ]]; then
  account_hog="${GROUNDHOG_LOCAL_ACCOUNT_HOG:-1000}"
  hogd_protocol="${GROUNDHOG_LOCAL_HOGD_PROTOCOL:-}"
else
  account_hog="${GROUNDHOG_E2E_ACCOUNT_HOG:-1000}"
  hogd_protocol="${GROUNDHOG_E2E_HOGD_PROTOCOL:-}"
fi

node_args=(
  --json
  --port 0
  --dev-account-count 3
  --dev-account-hog "$account_hog"
  --hog-devnode-binary "$devnode_binary"
  --contract-artifacts-dir "$contract_artifacts_dir"
)
if [[ -n "$hogd_protocol" ]]; then
  node_args+=(--hogd-protocol "$hogd_protocol")
fi

overall_started="$(millis)"
# Long-lived children must not retain the environment lock if the supervisor dies.
setsid "$groundhog_cli" node "${node_args[@]}" 9>&- >"$node_output" 2>"$node_log" &
node_pid=$!

startup=""
for (( attempt = 0; attempt < 480; attempt += 1 )); do
  if ! kill -0 "$node_pid" 2>/dev/null; then
    wait "$node_pid" || true
    printf 'Groundhog node exited before becoming ready.\n' >&2
    exit 1
  fi
  if [[ -s "$node_output" ]]; then
    startup="$(node -e '
      const fs = require("node:fs");
      const envelope = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const rpcUrl = envelope?.data?.rpc_url;
      const manifest = envelope?.data?.runtime_manifest?.path;
      if (envelope?.ok !== true || typeof rpcUrl !== "string" || typeof manifest !== "string") process.exit(1);
      process.stdout.write(`${rpcUrl}\n${manifest}`);
    ' "$node_output" 2>/dev/null || true)"
    [[ -n "$startup" ]] && break
  fi
  sleep 0.25
done
if [[ -z "$startup" ]]; then
  printf 'Timed out waiting for Groundhog node startup metadata.\n' >&2
  exit 1
fi

mapfile -t startup_fields <<< "$startup"
rpc_url="${startup_fields[0]:-}"
runtime_manifest="${startup_fields[1]:-}"
if [[ -z "$rpc_url" || -z "$runtime_manifest" || ! -f "$runtime_manifest" ]]; then
  printf 'Groundhog node returned incomplete startup metadata.\n' >&2
  exit 1
fi
network_id="$(node -e 'const m=require(process.argv[1]);if(!/^[0-9a-f]{64}$/.test(m.networkHash))process.exit(1);process.stdout.write(m.networkHash)' "$runtime_manifest")"
node -e '
  const url=new URL(process.argv[1]);
  if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.username||url.password||url.pathname!=="/"||url.search||url.hash)process.exit(1);
' "$rpc_url" || { printf 'Groundhog node returned a non-loopback RPC origin.\n' >&2; exit 1; }

printf 'Building and deploying Game of Life to clean ledger at %s\n' "$rpc_url"
cd "$repo_root"
"$groundhog_cli" build -p game-of-life
"$groundhog_cli" keys generate phase-7-deployer >/dev/null
mkdir -p "$work_dir/contracts"
cp "$contract_artifacts_dir/dev_wallet.rv32a" "$work_dir/contracts/dev_wallet.rv32a"
cd "$work_dir"
"$groundhog_cli" config new local --network local --rpc-url "$rpc_url" \
  --network-hash "$network_id" --default-key phase-7-deployer --use --global >/dev/null
"$groundhog_cli" wallet create --key phase-7-deployer --name game-of-life-dev \
  --prefund 1000 --yes --rpc-url "$rpc_url" \
  --runtime-manifest "$runtime_manifest" >/dev/null
"$groundhog_cli" deploy --artifact "$repo_root/target/groundhog/game_of_life.rv32a" \
  --wallet game-of-life-dev \
  --rpc-url "$rpc_url" --runtime-manifest "$runtime_manifest" \
  --dry-run --json > "$work_dir/deploy-dry-run.json"
contract_address="$(node -e '
  const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))?.data?.predictedAddress;
  if(typeof value!=="string"||!/^0x[0-9a-f]{64}$/.test(value))process.exit(1);process.stdout.write(value);
' "$work_dir/deploy-dry-run.json")"
prefund_hog="$(node -e '
  const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const bytes=BigInt(fs.statSync(process.argv[2]).size);
  const c=m.bootstrap.storageCostModel;const raw=40004n*BigInt(c.baseDataItemCost)+25001024n*BigInt(c.bytestringCostPerByte)+64n*BigInt(c.rcqCostPerEntry)+BigInt(c.baseContractDeploymentCost)+bytes*BigInt(c.contractDeploymentCostPerByte);
  process.stdout.write(String((raw+9999999n)/10000000n));
' "$runtime_manifest" "$repo_root/target/groundhog/game_of_life.rv32a")"
"$groundhog_cli" transfer "$contract_address" "$prefund_hog" \
  --from game-of-life-dev --rpc-url "$rpc_url" \
  --runtime-manifest "$runtime_manifest" >/dev/null
node -e '
  const fs=require("node:fs");
  const envelope=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const signed=envelope?.data?.signedTx;
  const rpcUrl=process.argv[2];
  if(typeof signed!=="string")throw new Error("dry-run deployment omitted signedTx");
  let id=0;
  const rpc=async(method,params)=>{
    const response=await fetch(rpcUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:++id,method,params})});
    const value=await response.json();
    if(!response.ok||value.error)throw new Error(`${method} failed: ${JSON.stringify(value.error??value)}`);
    return value.result;
  };
  (async()=>{
    const hash=await rpc("groundhog_sendRawTransaction",[signed]);
    if(typeof hash!=="string"||!/^0x[0-9a-f]{64}$/.test(hash))throw new Error("deployment returned an invalid transaction hash");
    const deadline=Date.now()+120000;
    while(Date.now()<deadline){
      const receipt=await rpc("groundhog_getTransactionReceipt",[hash]);
      if(receipt!==null){process.stdout.write(`Deployment committed: ${hash}\n`);return;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error(`timed out waiting for deployment ${hash}`);
  })().catch(error=>{console.error(error);process.exit(1)});
' "$work_dir/deploy-dry-run.json" "$rpc_url"

initialization_started="$(millis)"
cd "$repo_root"
GROUNDHOG_RPC_URL="$rpc_url" \
GROUNDHOG_RUNTIME_MANIFEST="$runtime_manifest" \
GROUNDHOG_CONTRACT_ADDRESS="$contract_address" \
GAME_OF_LIFE_OUTER_GAS=60000000000 \
GAME_OF_LIFE_TARGET_GAS=59000000000 \
GAME_OF_LIFE_TIMEOUT_SECONDS=600 \
  cargo test -p game-of-life-live-test --release --test feasibility \
    initializes_complete_world --locked -- --ignored --exact --nocapture
initialization_ms=$(( $(millis) - initialization_started ))

indexer_port="$(free_port)"
app_port="$(free_port)"
indexer_url="http://127.0.0.1:$indexer_port"
app_url="http://127.0.0.1:$app_port"
persona_setup_started="$(millis)"
GROUNDHOG_CLI="$groundhog_cli" \
GROUNDHOG_RPC_URL="$rpc_url" \
GROUNDHOG_RUNTIME_MANIFEST="$runtime_manifest" \
GROUNDHOG_CONTRACT_ADDRESS="$contract_address" \
GAME_OF_LIFE_INDEXER_URL="$indexer_url" \
GAME_OF_LIFE_ENV_FINGERPRINT_FILE="$work_dir/env.fingerprint" \
  bash "$app_dir/scripts/setup-local.sh"
persona_setup_ms=$(( $(millis) - persona_setup_started ))
generated_environment_fingerprint="$(<"$work_dir/env.fingerprint")"

printf 'Starting indexer and waiting for the first complete publication\n'
cargo build -p game-of-life-indexer --release --locked
export GROUNDHOG_RPC_URL="$rpc_url"
export GROUNDHOG_NETWORK_ID="$network_id"
export GROUNDHOG_CONTRACT_ADDRESS="$contract_address"
export GAME_OF_LIFE_ARTIFACT_ROOT="$work_dir/artifacts"
export GAME_OF_LIFE_INDEXER_DB="$work_dir/indexer.sqlite3"
export GAME_OF_LIFE_INDEXER_LISTEN="127.0.0.1:$indexer_port"
export GAME_OF_LIFE_CORS_ORIGINS="$app_url"
index_started="$(millis)"
setsid "$repo_root/target/release/game-of-life-indexer" 9>&- >"$indexer_log" 2>&1 &
indexer_pid=$!
latest_url="$indexer_url/v1/worlds/$network_id/$contract_address/latest.json"
for (( attempt = 0; attempt < 600; attempt += 1 )); do
  if ! kill -0 "$indexer_pid" 2>/dev/null; then
    wait "$indexer_pid" || true
    printf 'Indexer exited before publishing.\n' >&2
    exit 1
  fi
  curl --fail --silent --show-error "$latest_url" >/dev/null 2>&1 && break
  sleep 0.25
done
curl --fail --silent --show-error "$latest_url" >/dev/null
first_ready_manifest_ms=$(( $(millis) - index_started ))

if [[ "$dev_server" == "1" ]]; then
  printf 'Starting the credential-guarded app\n'
else
  printf 'Starting the credential-guarded app and running the live browser journey\n'
fi
cd "$app_dir"
setsid npm run dev -- --host 127.0.0.1 --port "$app_port" 9>&- >"$vite_log" 2>&1 &
vite_pid=$!
for (( attempt = 0; attempt < 240; attempt += 1 )); do
  if ! kill -0 "$vite_pid" 2>/dev/null; then
    wait "$vite_pid" || true
    printf 'Vite exited before becoming ready.\n' >&2
    exit 1
  fi
  curl --fail --silent --show-error "$app_url" >/dev/null 2>&1 && break
  sleep 0.25
done
curl --fail --silent --show-error "$app_url" >/dev/null

if [[ "$dev_server" == "1" ]]; then
  printf '\nGame of Life local stack is ready:\n'
  printf '  App:     %s\n' "$app_url"
  printf '  Indexer: %s\n' "$indexer_url"
  printf '  RPC:     %s\n' "$rpc_url"
  printf 'Press Ctrl-C to stop the stack and restore .env.local.\n'
  set +e
  wait -n "$node_pid" "$indexer_pid" "$vite_pid"
  stopped_status=$?
  set -e
  printf 'A local service exited unexpectedly.\n' >&2
  if (( stopped_status == 0 )); then
    exit 1
  fi
  exit "$stopped_status"
fi

mkdir -p "$evidence_dir"
browser_started="$(millis)"
GAME_OF_LIFE_APP_URL="$app_url" \
GAME_OF_LIFE_REFERENCE_HOST="$(uname -m) $(uname -sr)" \
PHASE7_BROWSER_EVIDENCE="$browser_evidence" \
  "$app_dir/node_modules/.bin/playwright" test \
    --config "$app_dir/playwright.local.config.ts"
browser_journey_ms=$(( $(millis) - browser_started ))

printf 'Restarting the indexer against durable evidence and immutable artifacts\n'
curl --fail --silent --show-error "$latest_url" >"$work_dir/latest-before.json"
metrics_before="$(grep -c 'game_of_life_indexer_metric' "$indexer_log")"
scope="$network_id:$contract_address"
cursor_before="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT hex(value) FROM service_state WHERE key='cursor:$scope';")"
evidence_before="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT count(*) FROM evidence WHERE network='$network_id' AND contract='$contract_address';")"
events_before="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT count(*) FROM chain_events WHERE scope='$scope';")"
evidence_content_before="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT digest || ':' || hex(provenance) FROM evidence WHERE network='$network_id' AND contract='$contract_address' ORDER BY digest;")"
event_content_before="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT transaction_hash || ':' || event_index || ':' || hex(event) FROM chain_events WHERE scope='$scope' ORDER BY transaction_hash,event_index;")"
if [[ -z "$cursor_before" || "$evidence_before" -lt 1 || "$events_before" -lt 1 ]]; then
  printf 'Indexer did not persist its cursor and verified event evidence.\n' >&2
  exit 1
fi
stop_process "$indexer_pid"
indexer_pid=""
setsid "$repo_root/target/release/game-of-life-indexer" 9>&- >>"$indexer_log" 2>&1 &
indexer_pid=$!
for (( attempt = 0; attempt < 240; attempt += 1 )); do
  curl --fail --silent --show-error "$latest_url" >/dev/null 2>&1 && break
  sleep 0.25
done
curl --fail --silent --show-error "$latest_url" >/dev/null
status_url="$indexer_url/v1/worlds/$network_id/$contract_address/status.json"
for (( attempt = 0; attempt < 240; attempt += 1 )); do
  curl --fail --silent "$status_url" >"$work_dir/status-after.json" 2>/dev/null || true
  if node -e '
    const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    if(value.state!=="idle"||value.published===null)process.exit(1);
  ' "$work_dir/status-after.json" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
node -e '
  const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(value.state!=="idle"||value.published===null)process.exit(1);
' "$work_dir/status-after.json"
curl --fail --silent --show-error "$latest_url" >"$work_dir/latest-after.json"
cmp --silent "$work_dir/latest-before.json" "$work_dir/latest-after.json"
sleep 1
metrics_after="$(grep -c 'game_of_life_indexer_metric' "$indexer_log")"
cursor_after="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT hex(value) FROM service_state WHERE key='cursor:$scope';")"
evidence_after="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT count(*) FROM evidence WHERE network='$network_id' AND contract='$contract_address';")"
events_after="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT count(*) FROM chain_events WHERE scope='$scope';")"
evidence_content_after="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT digest || ':' || hex(provenance) FROM evidence WHERE network='$network_id' AND contract='$contract_address' ORDER BY digest;")"
event_content_after="$(sqlite3 "$GAME_OF_LIFE_INDEXER_DB" "SELECT transaction_hash || ':' || event_index || ':' || hex(event) FROM chain_events WHERE scope='$scope' ORDER BY transaction_hash,event_index;")"
if [[ "$metrics_after" != "$metrics_before" || "$cursor_after" != "$cursor_before" || "$evidence_after" != "$evidence_before" || "$events_after" != "$events_before" || "$evidence_content_after" != "$evidence_content_before" || "$event_content_after" != "$event_content_before" ]]; then
  printf 'Indexer restart rebuilt artifacts or failed to restore durable state.\n' >&2
  exit 1
fi

generated_bytes="$(du -sb "$work_dir/artifacts")"
generated_bytes="${generated_bytes%%[[:space:]]*}"
overall_ms=$(( $(millis) - overall_started ))
export PHASE7_RUN_EVIDENCE="$run_evidence"
export PHASE7_INITIALIZATION_MS="$initialization_ms"
export PHASE7_PERSONA_SETUP_MS="$persona_setup_ms"
export PHASE7_FIRST_READY_MANIFEST_MS="$first_ready_manifest_ms"
export PHASE7_BROWSER_JOURNEY_MS="$browser_journey_ms"
export PHASE7_GENERATED_BYTES="$generated_bytes"
export PHASE7_OVERALL_MS="$overall_ms"
node -e '
  const fs=require("node:fs");
  const result={schemaVersion:1,initializationMs:Number(process.env.PHASE7_INITIALIZATION_MS),personaSetupAndCallerCheckMs:Number(process.env.PHASE7_PERSONA_SETUP_MS),firstReadyManifestMs:Number(process.env.PHASE7_FIRST_READY_MANIFEST_MS),browserJourneyMs:Number(process.env.PHASE7_BROWSER_JOURNEY_MS),generatedApparentBytes:Number(process.env.PHASE7_GENERATED_BYTES),overallMs:Number(process.env.PHASE7_OVERALL_MS),indexerRestartVerified:true};
  fs.writeFileSync(process.env.PHASE7_RUN_EVIDENCE,`${JSON.stringify(result,null,2)}\n`,{mode:0o600});
'
cp "$indexer_log" "$evidence_dir/phase-7-indexer.log"
printf 'Clean-ledger acceptance passed. Evidence: %s and %s\n' "$run_evidence" "$browser_evidence"
