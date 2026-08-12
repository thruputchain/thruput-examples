#!/usr/bin/env bash

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
groundhog_cli="${GROUNDHOG_CLI:-/home/chambaz/Work/groundhog-rpc/target/debug/groundhog}"
build_root="${TMPDIR:-/tmp}/groundhog-standard-token-reproducibility"
build_a="$build_root/build-a"
build_b="$build_root/build-b"
source_diff="$build_root/source.diff"
untracked_archive="$build_root/untracked.tar"
source_archive="$build_root/source.tar"
release_manifest="$root/docs/releases/standard-token-factory-v1.json"

rm -rf "$build_root"
mkdir -p "$build_root"

git -C "$root" diff --binary HEAD -- \
    Cargo.lock \
    Cargo.toml \
    rust-toolchain.toml \
    contracts/standard-token \
    contracts/standard-token-factory \
    contracts/standard-token-factory-if \
    helpers/token-factory-test-if \
    helpers/token-factory-test-wallet > "$source_diff"

mapfile -d '' untracked < <(
    git -C "$root" ls-files --others --exclude-standard -z -- \
        Cargo.lock \
        Cargo.toml \
        rust-toolchain.toml \
        contracts/standard-token \
        contracts/standard-token-factory \
        contracts/standard-token-factory-if \
        helpers/token-factory-test-if \
        helpers/token-factory-test-wallet
)
if ((${#untracked[@]})); then
    tar -C "$root" --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 \
        --numeric-owner -cf "$untracked_archive" -- "${untracked[@]}"
else
    : > "$untracked_archive"
fi

mapfile -d '' source_files < <(
    {
        git -C "$root" ls-files -z -- \
            Cargo.lock \
            Cargo.toml \
            rust-toolchain.toml \
            contracts/standard-token \
            contracts/standard-token-factory \
            contracts/standard-token-factory-if \
            helpers/token-factory-test-if \
            helpers/token-factory-test-wallet
        git -C "$root" ls-files --others --exclude-standard -z -- \
            Cargo.lock \
            Cargo.toml \
            rust-toolchain.toml \
            contracts/standard-token \
            contracts/standard-token-factory \
            contracts/standard-token-factory-if \
            helpers/token-factory-test-if \
            helpers/token-factory-test-wallet
    } | sort -zu
)
tar -C "$root" --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 \
    --numeric-owner -cf "$source_archive" -- "${source_files[@]}"

for package in standard-token standard-token-factory token-factory-test-wallet; do
    "$groundhog_cli" build -p "$package" --target rv32 --target-dir "$build_a" -- --locked
    "$groundhog_cli" build -p "$package" --target rv32 --target-dir "$build_b" -- --locked
done

for artifact in \
    standard_token.rv32a \
    standard_token.spec.json \
    standard_token.spec.xdr \
    standard_token_factory.rv32a \
    standard_token_factory.spec.json \
    standard_token_factory.spec.xdr \
    token_factory_test_wallet.rv32a \
    token_factory_test_wallet.spec.json \
    token_factory_test_wallet.spec.xdr; do
    cmp "$build_a/groundhog/$artifact" "$build_b/groundhog/$artifact"
done

verify_release_artifact() {
    local section="$1"
    local artifact="$2"

    test "$(wc -c < "$build_a/groundhog/$artifact.rv32a")" \
        -eq "$(jq -r ".$section.artifactBytes" "$release_manifest")"
    test "$(sha256sum "$build_a/groundhog/$artifact.rv32a" | cut -d' ' -f1)" \
        = "$(jq -r ".$section.artifactSha256" "$release_manifest")"
    test "$(sha256sum "$build_a/groundhog/$artifact.spec.json" | cut -d' ' -f1)" \
        = "$(jq -r ".$section.specJsonSha256" "$release_manifest")"
    test "$(sha256sum "$build_a/groundhog/$artifact.spec.xdr" | cut -d' ' -f1)" \
        = "$(jq -r ".$section.specXdrSha256" "$release_manifest")"
}

verify_release_artifact token standard_token
verify_release_artifact factory standard_token_factory
verify_release_artifact testWallet token_factory_test_wallet

git -C "$root" merge-base --is-ancestor \
    "$(jq -r '.workspace.baseRevision' "$release_manifest")" HEAD
test "$(sha256sum "$source_archive" | cut -d' ' -f1)" \
    = "$(jq -r '.workspace.sourceTreeSha256' "$release_manifest")"
test "$(sha256sum "$root/Cargo.lock" | cut -d' ' -f1)" \
    = "$(jq -r '.workspace.cargoLockSha256' "$release_manifest")"
test "$(rustc --version)" = "$(jq -r '.workspace.rustc' "$release_manifest")"
test "$(cargo --version)" = "$(jq -r '.workspace.cargo' "$release_manifest")"
test "$("$groundhog_cli" --version | cut -d' ' -f2)" \
    = "$(jq -r '.builder.version' "$release_manifest")"
test "$(sha256sum "$groundhog_cli" | cut -d' ' -f1)" \
    = "$(jq -r '.builder.binarySha256' "$release_manifest")"

if test -s "$source_diff" || test -s "$untracked_archive"; then
    worktree_dirty=true
else
    worktree_dirty=false
fi

{
    printf 'workspace_head=%s\n' "$(git -C "$root" rev-parse HEAD)"
    printf 'worktree_dirty=%s\n' "$worktree_dirty"
    printf 'source_diff_sha256=%s\n' "$(sha256sum "$source_diff" | cut -d' ' -f1)"
    printf 'untracked_source_sha256=%s\n' "$(sha256sum "$untracked_archive" | cut -d' ' -f1)"
    printf 'source_tree_sha256=%s\n' "$(sha256sum "$source_archive" | cut -d' ' -f1)"
    printf 'cargo_lock_sha256=%s\n' "$(sha256sum "$root/Cargo.lock" | cut -d' ' -f1)"
    printf 'rustc=%s\n' "$(rustc --version)"
    printf 'cargo=%s\n' "$(cargo --version)"
    printf 'groundhog_cli=%s\n' "$groundhog_cli"
    printf 'groundhog=%s\n' "$("$groundhog_cli" --version)"
    printf 'groundhog_cli_sha256=%s\n' "$(sha256sum "$groundhog_cli" | cut -d' ' -f1)"
    printf 'release_manifest_sha256=%s\n' "$(sha256sum "$release_manifest" | cut -d' ' -f1)"
    sha256sum \
        "$build_a/groundhog/standard_token.rv32a" \
        "$build_a/groundhog/standard_token.spec.json" \
        "$build_a/groundhog/standard_token.spec.xdr" \
        "$build_a/groundhog/standard_token_factory.rv32a" \
        "$build_a/groundhog/standard_token_factory.spec.json" \
        "$build_a/groundhog/standard_token_factory.spec.xdr" \
        "$build_a/groundhog/token_factory_test_wallet.rv32a" \
        "$build_a/groundhog/token_factory_test_wallet.spec.json" \
        "$build_a/groundhog/token_factory_test_wallet.spec.xdr"
    wc -c \
        "$build_a/groundhog/standard_token.rv32a" \
        "$build_a/groundhog/standard_token_factory.rv32a" \
        "$build_a/groundhog/token_factory_test_wallet.rv32a"
} > "$build_root/evidence.txt"

cat "$build_root/evidence.txt"
