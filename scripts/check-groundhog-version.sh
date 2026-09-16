#!/usr/bin/env bash

set -euo pipefail

cli_version="${1:?Pass the output of groundhog --version}"
version_pattern='^groundhog (0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?(\+([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?($|[[:space:]].*)'

if [[ "$cli_version" =~ $version_pattern ]]; then
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  prerelease="${BASH_REMATCH[4]}"

  # A prerelease of the minimum itself is older than the stable minimum.
  if (( major > 0 || minor > 17 || (minor == 17 && patch > 4) )) ||
     { (( minor == 17 && patch == 4 )) && [[ -z "$prerelease" ]]; }; then
    exit 0
  fi
fi

printf 'Groundhog CLI 0.17.4 or newer is required; found %s.\n' "$cli_version" >&2
exit 1
