#!/usr/bin/env bash

set -euo pipefail

# Byte-wise, locale-independent string comparison below.
export LC_ALL=C

cli_version="${1:?Pass the output of groundhog --version}"
version_pattern='^groundhog (0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?(\+([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?($|[[:space:]].*)'

if [[ "$cli_version" =~ $version_pattern ]]; then
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  prerelease="${BASH_REMATCH[4]}"

  # Anything strictly above 0.22.1, or 0.22.1 itself. A prerelease of 0.22.1
  # sorts below the stable release, so it does not satisfy the minimum.
  if (( major > 0 || minor > 22 || (minor == 22 && patch > 1) )) \
    || { (( minor == 22 && patch == 1 )) && [[ -z "$prerelease" ]]; }; then
    exit 0
  fi
fi

printf 'Groundhog CLI 0.22.1 or newer is required; found %s.\n' "$cli_version" >&2
exit 1
