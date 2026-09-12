#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$app_dir/scripts/generate-contract-bindings.sh"
tsx "$app_dir/scripts/setup-local.ts"
