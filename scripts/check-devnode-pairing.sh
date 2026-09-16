#!/usr/bin/env bash

# Check that a hog-devnode is from the same client release as the groundhog CLI
# that will drive it.
#
# The two share a runtime-manifest schema, so a mismatched pair fails partway
# into a run with a complaint about the manifest -- `runtime manifest is missing
# endpoints.schedulerGateway`, say -- which names neither binary nor version.
#
# Pass the output of each `--version`, so the comparison can be tested without
# either binary present.

set -euo pipefail

cli_version="${1:?Pass the output of groundhog --version}"
devnode_version="${2:?Pass the output of hog-devnode --version}"

# A released CLI reports `groundhog <component> (commit <sha>, release <X.Y.Z>)`.
# One built from source reports no release at all, and there is then nothing to
# match against -- which is not a reason to refuse to run.
release_pattern='release ((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))(\)|$|[[:space:]])'
if [[ ! "$cli_version" =~ $release_pattern ]]; then
  printf 'Note: %s reports no release version, so its devnode cannot be checked against it.\n' \
    "$cli_version" >&2
  exit 0
fi
cli_release="${BASH_REMATCH[1]}"

# `hog-devnode <X.Y.Z>`, sometimes with a prerelease suffix.  0.1.27-rc.7 is a
# build of the 0.1.27 release and pairs with it, so the release alone is what
# has to agree.
# The same shape `check-groundhog-version.sh` accepts: a semver triple, with an
# optional prerelease and build, and nothing else glued to it -- so a malformed
# `0.1.27.1` is reported rather than quietly read as 0.1.27.
devnode_pattern='^hog-devnode ((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))(-([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?(\+([0-9A-Za-z-]+\.)*[0-9A-Za-z-]+)?($|[[:space:]].*)'
if [[ ! "$devnode_version" =~ $devnode_pattern ]]; then
  printf 'Could not read a release version from hog-devnode --version: %s\n' "$devnode_version" >&2
  exit 1
fi
devnode_release="${BASH_REMATCH[1]}"

if [[ "$cli_release" != "$devnode_release" ]]; then
  printf 'The devnode and the CLI are from different client releases:\n' >&2
  printf '  CLI     %s -> release %s\n' "$cli_version" "$cli_release" >&2
  printf '  devnode %s -> release %s\n' "$devnode_version" "$devnode_release" >&2
  printf 'Use the hog-devnode from the same client bundle as the CLI.\n' >&2
  exit 1
fi
