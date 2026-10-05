#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$script_dir/check-groundhog-version.sh"

for version in \
  'groundhog 0.22.1 (commit unavailable)' \
  'groundhog 0.22.1+build.1' \
  'groundhog 0.22.2' \
  'groundhog 0.22.2-rc.1' \
  'groundhog 0.22.2-rc.1+build.42 (commit abc123)' \
  'groundhog 0.23.0-pre.1' \
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
  'groundhog 0.19.0' \
  'groundhog 0.21.3' \
  'groundhog 0.22.0' \
  'groundhog 0.22.0-rc.1' \
  'groundhog 0.22.1-pre.1' \
  'groundhog 0.22.1-pre.2' \
  'groundhog 0.22.1-pre.2+build.1' \
  'groundhog 0.22.1-rc.1' \
  'groundhog 0.22.1-alpha.9' \
  'groundhog 0.22.0-rc.1+build.1' \
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
  [[ "$output" == "Groundhog CLI 0.22.1 or newer is required; found $version." ]]
done

printf 'Groundhog CLI version checks passed (28 cases).\n'
