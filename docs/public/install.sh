#!/bin/sh
# jup installer for macOS, Linux, and other POSIX systems.
#
#   curl -fsSL https://jup.unjs.io/install.sh | sh
#
# jup is a JavaScript program, so this script does not install jup. It makes
# sure a runtime exists and then hands over to `jup self-install`, which is the
# command that knows where the copy belongs (<home>/self/<version>) and which
# names go on PATH. Everything below is bootstrap.
#
# The runtime is whatever the machine already has. Only when there is neither a
# recent enough Node.js nor a bun does this download one: Node.js, from the same
# signed npm artifact jup's own table names (`node-<target>`), at the version
# that table calls node's default.
#
# It lands in the store, as `<home>/v1/node/<version>` with a §07.2 marker, and
# `<home>/node/bin/node` is a *hard link* to the binary inside it. One download,
# one copy of the bytes, both roles served. Bootstrapping a version jup does not
# want is what used to leave a fresh machine holding two ~200 MB copies of Node:
# this script's, and the one the first real command fetched.
#
# The link is what keeps the two roles apart. <home>/node is a sibling of the
# store's `v1`, so `jup cache clean` cannot take it away, and §10.1 therefore
# lets the shims name it — which is what makes a machine with no runtime end up
# with a working install rather than one whose `#!/usr/bin/env node` resolves to
# nothing. A hard link keeps that true across a clean that unlinks the store's
# name, for one inode and no bytes.
#
# Writing into the store is only allowed over bytes verified the way §06.1
# verifies them, so the download's npm signature is checked here — §06.3's
# payload, algorithm and embedded key, in openssl — before anything is promoted.
# Where openssl is missing, which is the one thing that stops this script running
# that check, the copy is parked at <home>/node alone and jup downloads and
# verifies its own on first use, exactly as before.
#
# It is node and not bun for one measured reason: §10.2's shims are symlinks to
# one shared stub that dispatches on `basename(process.argv[1])`, and bun sets
# that to the *realpath* of the script where node leaves the path as invoked.
# Every shim under a bun shebang therefore reads its own name as
# `shim-proxy.mjs`. A preinstalled bun still runs this script and `self-install`
# fine — it is only the shebang that cannot be bun.
#
# Environment:
#   JUP_HOME                jup's store root (default: $XDG_CACHE_HOME/jup)
#   JUP_SHIM_DIRECTORY      where `self-install` puts jup and corepack
#   JUP_INSTALL_REGISTRY    npm registry to bootstrap from
#
# Options: --version <spec> picks the jup release; --dir <path> is
# `self-install --install-directory`. Anything else is passed through to
# `self-install` unread, so its own parser reports it.
#
# Progress goes to stderr and only jup's own output reaches stdout, so a
# `--json`-style consumer downstream sees nothing of the bootstrap.
#
# Everything is inside main(), called on the last line, so a download that is
# cut short cannot run half a script.

set -eu

# jup's `engines.node`. A machine whose only Node is older is treated as having
# none: jup would install, and then fail on the first command with an error
# about syntax rather than about the version.
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=18

# The two values this script shares with the compiled-in table, stamped by
# `scripts/refresh-table.mjs` (§16, Built-in table and trust keys) and not to be
# edited by hand. Table data lives in `src/config/`; these are copies because a
# bootstrap runs before there is a jup to ask, and the stamper is what stops
# them from becoming a second, drifting source.
#
# `NODE_VERSION` is `node.default` from `src/config/table.ts`. Any other version
# is the duplicate-download bug: jup would want its own on the first command.
NODE_VERSION=24.20.0

# §02.6's trust store for the default registry, each key the base64 DER
# SubjectPublicKeyInfo `src/config/keys.ts` holds, space separated.
NPM_TRUST_KEYS="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g=="

# `JUP_NPM_REGISTRY` is jup's own setting (§11.2) and is honoured here for the
# machine that has to reach a mirror for everything, bootstrap included.
REGISTRY="${JUP_INSTALL_REGISTRY:-${JUP_NPM_REGISTRY:-${COREPACK_NPM_REGISTRY:-https://registry.npmjs.org}}}"

# Set by find_runtime or install_node. A variable rather than a return value:
# `err` inside a command substitution would only leave the subshell, and this
# is the one result worth not routing through one.
RUNTIME=

err() {
  echo "jup install: $*" >&2
  exit 1
}

note() {
  echo "jup install: $*" >&2
}

usage() {
  cat <<'EOF'
Usage: install.sh [--version <spec>] [--dir <path>] [self-install options]

  --version <spec>  jup version or npm dist-tag to install (default: latest).
  --dir <path>      Install the jup and corepack commands here.
  --help            Show this message.

Any other option is passed through to `jup self-install`.
EOF
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# curl and wget cover every machine this script runs on; a system with neither
# has no way to have fetched this script either, though it may have been copied.
fetch() {
  if have curl; then
    curl -fsSL "$1"
  elif have wget; then
    wget -qO- "$1"
  else
    err "neither curl nor wget is available"
  fi
}

download() {
  # -f so a 404 is a failure rather than an HTML page written to disk.
  if have curl; then
    curl -fsSL "$1" -o "$2"
  elif have wget; then
    wget -qO "$2" "$1"
  else
    err "neither curl nor wget is available"
  fi
}

# The one string this script reads out of a registry document, without a JSON
# parser: npm serves these on a single line, and `dist.tarball` and
# `dist.integrity` each appear once in a version document.
json_string() {
  sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p'
}

# Advisory, not a gate: the registry serves both the metadata and the tarball,
# so a host that could alter one could alter the other. It catches a truncated
# or stale-cached download, which is what actually goes wrong here. Skipped
# rather than failed when there is no openssl to compute `sha512-<base64>`.
check_integrity() {
  have openssl || return 0
  [ -n "$2" ] || return 0
  actual="sha512-$(openssl dgst -sha512 -binary "$1" | openssl base64 -A)"
  [ "$2" = "$actual" ] || err "checksum mismatch for $3 (expected $2, got $actual)"
}

# §06.3's check, in sh: ECDSA-with-SHA-256 over `<package>@<version>:<integrity>`
# against §02.6's embedded keys. Same payload, same algorithm and same key
# material jup verifies with; only the implementation differs.
#
# Three outcomes, because they mean different things. 0 is verified, and is what
# lets the caller promote into the store. 1 is "not checkable here" — no
# openssl, or a mirror serving documents with no signatures — and downgrades to
# the old placement. 2 is checkable and wrong, which is a registry serving an
# artifact nothing vouches for, and is a hard failure.
#
# Every `"sig"` in the document is tried against every embedded key rather than
# pairing each with its own `keyid`, which would want a JSON parser. That costs
# nothing: a signature verifying under one of our keys was made by that key,
# whatever the document claims about it.
verify_signature() {
  vs_meta=$1
  vs_package=$2
  vs_version=$3
  vs_integrity=$4
  vs_dir=$5

  have openssl || return 1
  [ -n "$vs_integrity" ] || return 1

  printf '%s@%s:%s' "$vs_package" "$vs_version" "$vs_integrity" >"$vs_dir/payload"

  # One `"sig":"…"` per line. The fields are comma separated, so splitting on
  # commas is what stops `json_string`'s single greedy match from reducing a
  # list of signatures to its last member.
  echo "$vs_meta" | tr ',' '\n' | sed -n 's/.*"sig":"\([^"]*\)".*/\1/p' >"$vs_dir/sigs"
  [ -s "$vs_dir/sigs" ] || return 1

  # Unquoted on purpose: `NPM_TRUST_KEYS` is a space-separated list and base64
  # has no spaces in it, so word splitting is the iteration.
  for vs_key in $NPM_TRUST_KEYS; do
    printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' \
      "$vs_key" >"$vs_dir/key.pem"
    while IFS= read -r vs_sig; do
      [ -n "$vs_sig" ] || continue
      printf '%s' "$vs_sig" | openssl base64 -d -A >"$vs_dir/sig.der" 2>/dev/null || continue
      if openssl dgst -sha256 -verify "$vs_dir/key.pem" -signature "$vs_dir/sig.der" \
        "$vs_dir/payload" >/dev/null 2>&1; then
        return 0
      fi
    done <"$vs_dir/sigs"
  done

  return 2
}

# The `<hex>` half of a marker's `sha512.<hex>` (§07.2), which jup writes from
# `hashStream`'s hex digest over the same tarball.
#
# `openssl dgst` labels its output and the label differs between OpenSSL and
# LibreSSL, so the value is taken after the `=` and then checked for being hex
# at all: output this cannot read is a reason to fall back, never to write a
# marker no one can read.
sha512_hex() {
  sh_hex=$(openssl dgst -sha512 "$1" 2>/dev/null | sed 's/.*= *//')
  case "$sh_hex" in
  "" | *[!0-9a-f]*) return 1 ;;
  esac
  echo "$sh_hex"
}

# §07.1's chain, minus the Windows branch. `install.ps1` is the other half.
store_home() {
  if [ -n "${JUP_HOME:-}" ]; then
    echo "$JUP_HOME"
  elif [ -n "${COREPACK_HOME:-}" ]; then
    echo "$COREPACK_HOME"
  elif [ -n "${XDG_CACHE_HOME:-}" ]; then
    echo "$XDG_CACHE_HOME/jup"
  elif [ -n "${HOME:-}" ]; then
    echo "$HOME/.cache/jup"
  fi
}

# The `{target}` half of `node-{target}`, spelled the way node's per-host
# packages spell it. On Apple Silicon the prefix is `node-bin-` rather than
# `node-`, because `node-darwin-arm64` belongs to an unrelated publisher; that
# rename is node's own (`node-bin-setup` makes it unconditionally), not this
# script's invention.
#
# Status 2 is the musl answer, which the caller reports separately: node
# publishes no musl build, so an Alpine host has to be told that rather than
# handed a glibc binary. The test is §15.28's — musl wins only when it is the
# *only* loader present, so a glibc distribution with musl merely installed
# stays glibc.
node_target() {
  case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) return 1 ;;
  esac

  case "$(uname -s)" in
  Darwin)
    if [ "$arch" = arm64 ]; then echo "bin-darwin-arm64"; else echo "darwin-x64"; fi
    ;;
  Linux)
    case "$arch" in
    arm64) musl=/lib/ld-musl-aarch64.so.1 glibc=/lib/ld-linux-aarch64.so.1 ;;
    *) musl=/lib/ld-musl-x86_64.so.1 glibc=/lib64/ld-linux-x86-64.so.2 ;;
    esac
    if [ -e "$musl" ] && [ ! -e "$glibc" ]; then return 2; fi
    echo "linux-$arch"
    ;;
  *) return 1 ;;
  esac
}

# Is this Node new enough to run jup? Called in an `if`, so `set -e` is off
# inside it and a runtime that fails to start is simply not a candidate.
node_supported() {
  # `node_` prefixes throughout: sh has no local scope, and an unprefixed
  # `version` here is main's `--version` a few frames up.
  node_version=$("$1" --version 2>/dev/null) || return 1
  node_version=${node_version#v}
  node_major=${node_version%%.*}
  node_rest=${node_version#*.}
  node_minor=${node_rest%%.*}
  case "$node_major$node_minor" in "" | *[!0-9]*) return 1 ;; esac
  if [ "$node_major" -gt "$NODE_MIN_MAJOR" ]; then return 0; fi
  if [ "$node_major" -eq "$NODE_MIN_MAJOR" ] && [ "$node_minor" -ge "$NODE_MIN_MINOR" ]; then
    return 0
  fi
  return 1
}

# The runtime to run jup under: the user's own first, then one an earlier run of
# this script left behind. Node before bun because jup's POSIX shims name `node`
# in their shebang, so a machine with both wants the one they will find.
find_runtime() {
  fr_home=$1

  for candidate in node bun; do
    path=$(command -v "$candidate" 2>/dev/null) || continue
    if [ "$candidate" = bun ] || node_supported "$path"; then
      RUNTIME=$path
      return 0
    fi
  done

  # One an earlier run of this script left behind, version-checked like the ones
  # on `PATH` rather than taken on sight: an installer old enough to have parked
  # a different major is precisely what `NODE_MIN_MAJOR` is here to catch, and
  # adopting one forever is how a machine never ends up running the version
  # jup's table names.
  if node_supported "$fr_home/node/bin/node"; then
    RUNTIME="$fr_home/node/bin/node"
    return 0
  fi

  # The store may already hold the entry `install_node` would write — an earlier
  # `jup cache install -g node`, an image seeded by `jup pack`, a re-run after <home>/node
  # was deleted. It cannot be named directly, because §10.2 forbids a shebang
  # into `v1` and `cache clean` is why, but linking it out is free and skips the
  # download entirely.
  if [ -f "$fr_home/v1/node/$NODE_VERSION/.jup" ] &&
    node_supported "$fr_home/v1/node/$NODE_VERSION/bin/node" &&
    link_runtime "$fr_home" "$fr_home/v1/node/$NODE_VERSION/bin/node"; then
    return 0
  fi

  return 1
}

# §10.2 tier 0's target: <home>/node/bin/node, the one path a shim's shebang may
# name on a machine whose only runtime jup put there.
#
# A hard link, not a copy. Both names are under <home> and so on one filesystem
# by construction, which makes the second name cost an inode and no bytes, and
# which keeps the inode alive when `cache clean` unlinks the store's name. A
# copy is the fallback for a filesystem that refuses the link, and it costs the
# 200 MB this exists to save, so it is never the first choice.
#
# `bin/node` alone is the whole tree. <home>/node exists to be a shebang target
# and to run `jup`, and node needs no sibling file for either; the swap through
# `node.new` is what clears an older installer's whole-distribution extraction
# rather than leaving its stale `lib/` beside a binary from another version.
link_runtime() {
  lr_home=$1
  lr_source=$2

  rm -rf "$lr_home/node.new"
  mkdir -p "$lr_home/node.new/bin" || return 1
  ln "$lr_source" "$lr_home/node.new/bin/node" 2>/dev/null ||
    cp "$lr_source" "$lr_home/node.new/bin/node" ||
    return 1
  chmod 755 "$lr_home/node.new/bin/node" 2>/dev/null || :

  rm -rf "$lr_home/node.old"
  if [ -e "$lr_home/node" ]; then
    mv "$lr_home/node" "$lr_home/node.old" || return 1
  fi
  mv "$lr_home/node.new" "$lr_home/node" || return 1
  rm -rf "$lr_home/node.old"

  RUNTIME="$lr_home/node/bin/node"
}

# Download `node-<target>` at `NODE_VERSION` and make a runtime out of it.
#
# The staging tree is under `v1` and not under `TMPDIR`, because both endings are
# a rename: §07.5's commit into the store, or the swap into <home>/node. Either
# one crossing a filesystem would turn into a 200 MB copy.
install_node() {
  home=$1
  tmp=$2
  stage=$3

  target=$(node_target) || case $? in
  2) err "node publishes no musl build, so there is nothing to download on this host; install Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR or newer (\`apk add nodejs\`), then re-run" ;;
  *) err "no supported node build for $(uname -s) $(uname -m); install Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR or newer, then re-run" ;;
  esac
  package="node-$target"

  note "no Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR+ and no bun found; downloading node $NODE_VERSION for $target"

  meta=$(fetch "$REGISTRY/$package/$NODE_VERSION") ||
    err "cannot reach $REGISTRY/$package/$NODE_VERSION"
  tarball=$(echo "$meta" | json_string tarball)
  [ -n "$tarball" ] || err "$REGISTRY/$package/$NODE_VERSION named no tarball"
  integrity=$(echo "$meta" | json_string integrity)

  download "$tarball" "$tmp/node.tgz" || err "download failed: $tarball"
  check_integrity "$tmp/node.tgz" "$integrity" "$package"

  rm -rf "$stage"
  mkdir -p "$stage" || err "cannot write to $home"
  tar -xzf "$tmp/node.tgz" -C "$stage" --strip-components=1 || err "cannot unpack $package"
  [ -f "$stage/bin/node" ] || err "$package did not contain bin/node"
  chmod 755 "$stage/bin/node"

  # The verdict decides *placement*, never whether the runtime is used: this
  # host has no other node, and refusing to bootstrap one over a check jup's own
  # download will repeat would leave it with nothing at all.
  #
  # Note what the two checks are worth together on the promoting branch:
  # `check_integrity` has already established that these bytes are the ones
  # `dist.integrity` names, and the signature below covers that same string. So
  # the signature covers the bytes, which is §06.1's tier 2 exactly.
  verdict=0
  verify_signature "$meta" "$package" "$NODE_VERSION" "$integrity" "$tmp" || verdict=$?
  case $verdict in
  0)
    if promote_node "$home" "$tmp" "$stage"; then
      return 0
    fi
    note "could not write the store entry; keeping node at $home/node alone"
    ;;
  2)
    err "the signature $REGISTRY publishes for $package@$NODE_VERSION does not verify against jup's embedded npm keys"
    ;;
  *)
    note "cannot verify $package@$NODE_VERSION here (no openssl); jup will download and verify its own copy on first use"
    ;;
  esac

  park_node "$home" "$stage"
}

# §07.2's `<home>/v1/<name>/<reference>` entry, written from the shell.
#
# Four things make this the entry jup itself would have written, and all four
# have to hold or the caller falls back to `park_node`:
#
#   * the directory is the plain version (§07.2), which is what the store probe
#     for an unpinned `node@<version>` opens;
#   * the marker's `hash` is a real `sha512.<hex>` over the tarball — not
#     §07.10's `unattributable.0`, because these bytes *were* hashed here and a
#     verified signature covers that digest;
#   * `bin` is the map node's own manifest declares, which is what `resolveBin`
#     reads for this package, checked against the extraction above;
#   * the marker goes in before the rename, so a `promote` losing this race
#     still finds a complete install (§07.5).
#
# It does not record a global default. §04.5's `lastKnownGood.json` is jup's
# bookkeeping and the table already names this version; writing one here would
# put a second hand-rolled state file in the bootstrap for nothing.
promote_node() {
  pn_home=$1
  pn_tmp=$2
  pn_stage=$3

  pn_hex=$(sha512_hex "$pn_tmp/node.tgz") || return 1

  pn_dest="$pn_home/v1/node/$NODE_VERSION"
  # Occupied means someone else got here first, and adopting their entry is
  # `find_runtime`'s job on the next run, not this one's. `mv` onto an existing
  # directory moves *into* it, which is the one outcome worth ruling out.
  [ ! -e "$pn_dest" ] || return 1

  printf '{"locator":{"name":"node","reference":"%s"},"bin":{"node":"bin/node"},"hash":"sha512.%s"}' \
    "$NODE_VERSION" "$pn_hex" >"$pn_stage/.jup" || return 1
  chmod 755 "$pn_stage" 2>/dev/null || :

  mkdir -p "$pn_home/v1/node" || return 1
  mv "$pn_stage" "$pn_dest" 2>/dev/null || return 1

  # Past the rename there is no returning 1. The staging tree *is* the store
  # entry now, and the caller's other placement has nothing left to move, so a
  # failure here is reported rather than quietly retried somewhere else.
  [ -f "$pn_dest/.jup" ] && [ -x "$pn_dest/bin/node" ] ||
    err "the store entry promoted to $pn_dest is incomplete"
  link_runtime "$pn_home" "$pn_dest/bin/node" ||
    err "cannot link $pn_dest/bin/node into $pn_home/node"
}

# The placement for bytes this host could not verify: the whole distribution at
# <home>/node, promoted by nobody and vouched for by nothing but TLS and
# `dist.integrity`. Deliberately *not* the store, so jup downloads and verifies
# its own copy on first use rather than adopting one that never cleared §06.1.
park_node() {
  pk_home=$1
  pk_stage=$2

  mkdir -p "$pk_home" || err "cannot create $pk_home"
  rm -rf "$pk_home/node.old"
  if [ -e "$pk_home/node" ]; then
    mv "$pk_home/node" "$pk_home/node.old" || err "cannot write to $pk_home"
  fi
  mv "$pk_stage" "$pk_home/node" || err "cannot write to $pk_home"
  rm -rf "$pk_home/node.old"
  RUNTIME="$pk_home/node/bin/node"
}

main() {
  version=latest

  # Options this script answers are consumed; the rest are rotated to the end of
  # "$@" and handed to `self-install`, which has its own parser and its own
  # messages for them.
  remaining=$#
  while [ "$remaining" -gt 0 ]; do
    arg=$1
    shift
    remaining=$((remaining - 1))
    case "$arg" in
    --version)
      [ "$remaining" -gt 0 ] || err "--version needs a value"
      version=$1
      shift
      remaining=$((remaining - 1))
      ;;
    --version=*) version=${arg#--version=} ;;
    --dir)
      [ "$remaining" -gt 0 ] || err "--dir needs a path"
      set -- "$@" --install-directory "$1"
      shift
      remaining=$((remaining - 1))
      ;;
    --dir=*) set -- "$@" --install-directory "${arg#--dir=}" ;;
    -h | --help)
      usage
      return 0
      ;;
    *) set -- "$@" "$arg" ;;
    esac
  done

  have tar || err "tar is required"

  home=$(store_home)
  [ -n "$home" ] || err "neither HOME nor JUP_HOME is set"

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/jup-install.XXXXXX") || err "cannot create a temporary directory"
  # §07.2 spells a half-filled install `jup-<pid>-<hex>`, and this is one: a
  # store scanned mid-bootstrap should read it as jup's own leftovers and not as
  # a cached version. Swept on the way out however that goes, along with the two
  # names `link_runtime` swaps through.
  stage="$home/v1/jup-$$-0"
  trap 'rm -rf "$tmp" "$stage" "$home/node.new" "$home/node.old"' EXIT INT TERM

  find_runtime "$home" || install_node "$home" "$tmp" "$stage"

  meta=$(fetch "$REGISTRY/jup/$version") || err "cannot reach $REGISTRY/jup/$version"
  tarball=$(echo "$meta" | json_string tarball)
  [ -n "$tarball" ] || err "$REGISTRY/jup/$version named no tarball; is '$version' a published version?"

  note "installing jup with $RUNTIME"
  download "$tarball" "$tmp/jup.tgz" || err "download failed: $tarball"
  check_integrity "$tmp/jup.tgz" "$(echo "$meta" | json_string integrity)" jup

  mkdir -p "$tmp/jup"
  tar -xzf "$tmp/jup.tgz" -C "$tmp/jup" --strip-components=1 || err "cannot unpack jup"
  [ -f "$tmp/jup/bin/jup.mjs" ] || err "the jup package did not contain bin/jup.mjs"

  # §15.43 tier 1 — the runtime hosting a chain that is about to run out of the
  # store, named here so `self-install` uses the one this script chose rather
  # than re-deriving it from a PATH that may have no `node` on it at all.
  JUP_HOST_RUNTIME="$RUNTIME"
  export JUP_HOST_RUNTIME

  # The handover. From here everything the user sees is jup's own output: where
  # the copy went, which names were linked, and the PATH line to add.
  "$RUNTIME" "$tmp/jup/bin/jup.mjs" self-install "$@"
}

main "$@"
