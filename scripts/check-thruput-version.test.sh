#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$script_dir/check-thruput-version.sh"

for version in \
  'thruput 0.33.0 (commit unavailable)' \
  'thruput 0.33.0+build.1' \
  'thruput 0.33.1' \
  'thruput 0.33.1-rc.1' \
  'thruput 0.33.1-rc.1+build.42 (commit abc123)' \
  'thruput 0.34.0-pre.1' \
  'thruput 1.0.0-rc.1' \
  'thruput 1.0.0' \
  'thruput 2.0.0'; do
  if ! bash "$check" "$version"; then
    printf 'Expected acceptance: %s\n' "$version" >&2
    exit 1
  fi
done

for version in \
  'thruput 0.27.0' \
  'thruput 0.28.0' \
  'thruput 0.28.9' \
  'thruput 0.14.0' \
  'thruput 0.19.0' \
  'thruput 0.21.3' \
  'thruput 0.22.0' \
  'thruput 0.22.0-rc.1' \
  'thruput 0.29.0' \
  'thruput 0.31.1' \
  'thruput 0.32.0' \
  'thruput 0.32.1' \
  'thruput 0.33.0-pre.1' \
  'thruput 0.33.0-rc.1' \
  'thruput 0.32.1-pre.1' \
  'thruput 0.32.1-pre.2' \
  'thruput 0.32.1-pre.2+build.1' \
  'thruput 0.32.1-rc.1' \
  'thruput 0.32.1-alpha.9' \
  'thruput 0.22.0-rc.1+build.1' \
  'thruput 0.16' \
  'thruput 0.16.0rc.1' \
  'thruput 0.16.0-' \
  'thruput 0.16.0+' \
  'thruput 0.16.0-rc..1' \
  'thruput 0.016.0' \
  'groundhog 0.32.1' \
  'another-cli 0.16.0' \
  'invalid'; do
  if output="$(bash "$check" "$version" 2>&1)"; then
    printf 'Expected rejection: %s\n' "$version" >&2
    exit 1
  fi
  [[ "$output" == "Thruput CLI 0.33.0 or newer is required; found $version." ]]
done

printf 'Thruput CLI version checks passed.\n'
