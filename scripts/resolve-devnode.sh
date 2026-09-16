#!/usr/bin/env bash

# Print the path of a hog-devnode to drive the groundhog CLI with, having
# checked the two are from the same client release.
#
# Used by every script that runs against a live devnode:
#
#     devnode="$(scripts/resolve-devnode.sh)"
#     export GROUNDHOG_DEVNODE_BINARY="$devnode"
#
# Assign first and export second: `export VAR="$(...)"` is one command whose
# status is export's own, so a failure here would not trip the caller's `set -e`.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! cli="$(command -v groundhog)"; then
  printf 'No groundhog on PATH. Install the client bundle, or put its bin/ on PATH.\n' >&2
  exit 1
fi

# The client bundle ships both binaries in one bin/, so a devnode beside the CLI
# is the matching one by construction.  An explicit GROUNDHOG_DEVNODE_BINARY
# still wins.
devnode="${GROUNDHOG_DEVNODE_BINARY:-$(dirname "$cli")/hog-devnode}"

if [[ ! -x "$devnode" ]]; then
  printf 'No usable hog-devnode at %s.\n' "$devnode" >&2
  if [[ -n "${GROUNDHOG_DEVNODE_BINARY:-}" ]]; then
    printf 'GROUNDHOG_DEVNODE_BINARY names it; check the path is right and executable.\n' >&2
  else
    printf 'Set GROUNDHOG_DEVNODE_BINARY, or use a client bundle whose bin/ holds both.\n' >&2
  fi
  exit 1
fi

bash "$script_dir/check-devnode-pairing.sh" "$("$cli" --version)" "$("$devnode" --version)"

printf '%s\n' "$devnode"
