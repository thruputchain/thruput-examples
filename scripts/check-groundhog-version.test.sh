#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$script_dir/check-groundhog-version.sh"

for version in \
  'groundhog 0.17.4' \
  'groundhog 0.17.4 (commit unavailable)' \
  'groundhog 0.17.4+build.1' \
  'groundhog 0.17.5-rc.1' \
  'groundhog 0.18.0' \
  'groundhog 0.18.0-rc.1 (commit unavailable)' \
  'groundhog 0.18.0-rc.1+build.42 (commit abc123)' \
  'groundhog 1.0.0-rc.1' \
  'groundhog 1.0.0' \
  'groundhog 2.0.0'; do
  if ! bash "$check" "$version"; then
    printf 'Expected acceptance: %s\n' "$version" >&2
    exit 1
  fi
done

for version in \
  'groundhog 0.14.0' \
  'groundhog 0.17.3' \
  'groundhog 0.17.3-rc.1' \
  'groundhog 0.17.4-rc.1' \
  'groundhog 0.17.4-rc.1+build.1' \
  'groundhog 0.16' \
  'groundhog 0.16.0rc.1' \
  'groundhog 0.16.0-' \
  'groundhog 0.16.0+' \
  'groundhog 0.16.0-rc..1' \
  'groundhog 0.016.0' \
  'another-cli 0.16.0' \
  'invalid'; do
  if output="$(bash "$check" "$version" 2>&1)"; then
    printf 'Expected rejection: %s\n' "$version" >&2
    exit 1
  fi
  [[ "$output" == "Groundhog CLI 0.17.4 or newer is required; found $version." ]]
done

printf 'Groundhog CLI version checks passed (23 cases).\n'
