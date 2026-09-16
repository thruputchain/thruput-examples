#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check="$script_dir/check-devnode-pairing.sh"

# Pairs that should be accepted: same release, however each side spells it.
while IFS='|' read -r cli devnode; do
  [[ -z "$cli" ]] && continue
  if ! bash "$check" "$cli" "$devnode" 2>/dev/null; then
    printf 'Expected acceptance: %s + %s\n' "$cli" "$devnode" >&2
    exit 1
  fi
done <<'PAIRS'
groundhog 0.17.0 (commit abe5c2f6, release 0.1.27)|hog-devnode 0.1.27
groundhog 0.17.0 (commit abe5c2f6, release 0.1.27)|hog-devnode 0.1.27-rc.7
groundhog 0.17.0 (commit abe5c2f6, release 0.1.28)|hog-devnode 0.1.28-rc.1+build.9
groundhog 1.0.0 (commit deadbeef, release 2.3.4)|hog-devnode 2.3.4
PAIRS

# A CLI built from source carries no release, so there is nothing to check and
# nothing to refuse.
while IFS='|' read -r cli devnode; do
  [[ -z "$cli" ]] && continue
  if ! bash "$check" "$cli" "$devnode" 2>/dev/null; then
    printf 'Expected acceptance (unversioned CLI): %s + %s\n' "$cli" "$devnode" >&2
    exit 1
  fi
done <<'PAIRS'
groundhog 0.17.1 (commit unavailable)|hog-devnode 0.1.27
groundhog 0.17.1|hog-devnode 0.1.23
PAIRS

# Pairs that should be refused.
while IFS='|' read -r cli devnode; do
  [[ -z "$cli" ]] && continue
  if bash "$check" "$cli" "$devnode" 2>/dev/null; then
    printf 'Expected refusal: %s + %s\n' "$cli" "$devnode" >&2
    exit 1
  fi
done <<'PAIRS'
groundhog 0.17.0 (commit abe5c2f6, release 0.1.27)|hog-devnode 0.1.23
groundhog 0.17.0 (commit abe5c2f6, release 0.1.27)|hog-devnode 0.1.28
groundhog 0.17.0 (commit abe5c2f6, release 0.1.27)|hog-devnode 0.1.27.1
groundhog 0.17.0 (commit abe5c2f6, release 0.1.27)|hogsim 0.1.27
groundhog 0.17.0 (commit abe5c2f6, release 0.1.27)|hog-devnode
groundhog 0.17.0 (commit abe5c2f6, release 0.1.27)|
PAIRS

# A prerelease of the *next* release is not a build of this one.
if bash "$check" \
  'groundhog 0.17.0 (commit abe5c2f6, release 0.1.27)' \
  'hog-devnode 0.1.28-rc.1' 2>/dev/null; then
  printf 'Expected refusal: a prerelease of the following release\n' >&2
  exit 1
fi

printf 'check-devnode-pairing: all cases pass\n'
