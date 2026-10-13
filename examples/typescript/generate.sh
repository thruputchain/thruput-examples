#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
cli="${THRUPUT_CLI:-thruput}"
bash scripts/check-thruput-version.sh "$("$cli" --version)"
"$cli" build -p counter -- --locked
mkdir -p examples/typescript/generated
"$cli" codegen ts target/thruput/counter.spec.xdr \
  --output examples/typescript/generated/counter.ts
npx --no-install prettier --write examples/typescript/generated/counter.ts
