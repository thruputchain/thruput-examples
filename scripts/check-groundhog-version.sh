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

  # Anything strictly above 0.19.x, or a 0.19 patch release.
  if (( major > 0 || minor > 19 || (minor == 19 && patch > 0) )); then
    exit 0
  fi

  # The minimum is itself a prerelease, 0.19.0-pre.1, because structured spec
  # ids (raw spec format 3) ship there and the older CLI rejects them. So
  # unlike a stable minimum, a 0.19.0 prerelease can satisfy it -- but only
  # one at or above pre.1.
  if (( minor == 19 && patch == 0 )); then
    # Stable outranks every prerelease of the same version.
    if [[ -z "$prerelease" ]]; then
      exit 0
    fi
    # Semver compares prerelease identifiers left to right, alphanumerics as
    # text and numerics as numbers. Only the first two matter against pre.1:
    # rc.1 outranks it (rc > pre), alpha.9 does not.
    identifier="${prerelease#-}"
    label="${identifier%%.*}"
    number="${identifier#*.}"
    if [[ "$number" == "$identifier" ]]; then
      number=0
    fi
    if [[ "$label" > "pre" ]]; then
      exit 0
    fi
    if [[ "$label" == "pre" ]] && [[ "$number" =~ ^[0-9]+$ ]] && (( number >= 1 )); then
      exit 0
    fi
  fi
fi

printf 'Groundhog CLI 0.19.0-pre.1 or newer is required; found %s.\n' "$cli_version" >&2
exit 1
