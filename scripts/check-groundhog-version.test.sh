#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$script_dir/check-groundhog-version.sh"

for version in \
  'groundhog 0.14.0' \
  'groundhog 0.14.0 (commit unavailable)' \
  'groundhog 0.14.0+build.1' \
  'groundhog 0.14.1-rc.1' \
  'groundhog 0.15.0' \
  'groundhog 0.16.0-rc.1 (commit unavailable)' \
  'groundhog 0.16.0-rc.1+build.42 (commit abc123)' \
  'groundhog 1.0.0-rc.1' \
  'groundhog 1.0.0' \
  'groundhog 2.0.0'; do
  if ! bash "$check" "$version"; then
    printf 'Expected acceptance: %s\n' "$version" >&2
    exit 1
  fi
done

for version in \
  'groundhog 0.10.4' \
  'groundhog 0.13.99' \
  'groundhog 0.13.99-rc.1' \
  'groundhog 0.14.0-rc.1' \
  'groundhog 0.14.0-rc.1+build.1' \
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
  [[ "$output" == "Groundhog CLI 0.14.0 or newer is required; found $version." ]]
done

printf 'Groundhog CLI version checks passed (23 cases).\n'
