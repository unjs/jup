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
# recent enough Node.js nor a bun does this download one: bun, from the same
# signed npm artifact jup's own table names (`@oven/bun-<target>`), into
# <home>/bun beside the store rather than anywhere on the user's PATH.
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

# `JUP_NPM_REGISTRY` is jup's own setting (§11.2) and is honoured here for the
# machine that has to reach a mirror for everything, bootstrap included.
REGISTRY="${JUP_INSTALL_REGISTRY:-${JUP_NPM_REGISTRY:-${COREPACK_NPM_REGISTRY:-https://registry.npmjs.org}}}"

# Set by find_runtime or install_bun. A variable rather than a return value:
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

# The `{target}` half of `@oven/bun-{target}`, spelled the way bun spells it.
# Linux is the one platform where <platform>-<arch> does not name an ABI, and
# the musl test is §15.28's: musl wins only when it is the *only* loader
# present, so a glibc distribution with musl merely installed stays glibc.
bun_target() {
  case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) return 1 ;;
  esac

  case "$(uname -s)" in
  Darwin) echo "darwin-$arch" ;;
  Linux)
    case "$arch" in
    aarch64) musl=/lib/ld-musl-aarch64.so.1 glibc=/lib/ld-linux-aarch64.so.1 ;;
    *) musl=/lib/ld-musl-x86_64.so.1 glibc=/lib64/ld-linux-x86-64.so.2 ;;
    esac
    if [ -e "$musl" ] && [ ! -e "$glibc" ]; then
      echo "linux-$arch-musl"
    else
      echo "linux-$arch"
    fi
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
  for candidate in node bun; do
    path=$(command -v "$candidate" 2>/dev/null) || continue
    if [ "$candidate" = bun ] || node_supported "$path"; then
      RUNTIME=$path
      return 0
    fi
  done
  if [ -x "$1/bun/bin/bun" ]; then
    RUNTIME="$1/bun/bin/bun"
    return 0
  fi
  return 1
}

# Download bun into <home>/bun. A sibling of `v1` and of `self`, for `self`'s
# reason (§07.11): `jup cache clean` frees cache entries, and a runtime the
# installation depends on is not one.
install_bun() {
  home=$1
  tmp=$2

  target=$(bun_target) ||
    err "no supported bun build for $(uname -s) $(uname -m); install Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR or newer and re-run"
  package="@oven/bun-$target"

  note "no Node.js $NODE_MIN_MAJOR.$NODE_MIN_MINOR+ and no bun found; downloading bun for $target"

  meta=$(fetch "$REGISTRY/$package/latest") || err "cannot reach $REGISTRY/$package"
  tarball=$(echo "$meta" | json_string tarball)
  [ -n "$tarball" ] || err "$REGISTRY/$package/latest named no tarball"

  download "$tarball" "$tmp/bun.tgz" || err "download failed: $tarball"
  check_integrity "$tmp/bun.tgz" "$(echo "$meta" | json_string integrity)" "$package"

  mkdir -p "$tmp/bun"
  tar -xzf "$tmp/bun.tgz" -C "$tmp/bun" --strip-components=1 || err "cannot unpack $package"
  [ -f "$tmp/bun/bin/bun" ] || err "$package did not contain bin/bun"
  chmod 755 "$tmp/bun/bin/bun"

  # Only reached when no usable bun was found at this path, so whatever is there
  # is a failed or half-finished earlier attempt.
  mkdir -p "$home" || err "cannot create $home"
  rm -rf "$home/bun"
  mv "$tmp/bun" "$home/bun" || err "cannot write to $home"
  RUNTIME="$home/bun/bin/bun"
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
  trap 'rm -rf "$tmp"' EXIT INT TERM

  find_runtime "$home" || install_bun "$home" "$tmp"

  meta=$(fetch "$REGISTRY/jup/$version") || err "cannot reach $REGISTRY/jup/$version"
  tarball=$(echo "$meta" | json_string tarball)
  [ -n "$tarball" ] || err "$REGISTRY/jup/$version named no tarball; is '$version' a published version?"

  note "installing jup with $RUNTIME"
  download "$tarball" "$tmp/jup.tgz" || err "download failed: $tarball"
  check_integrity "$tmp/jup.tgz" "$(echo "$meta" | json_string integrity)" jup

  mkdir -p "$tmp/jup"
  tar -xzf "$tmp/jup.tgz" -C "$tmp/jup" --strip-components=1 || err "cannot unpack jup"
  [ -f "$tmp/jup/bin/jup.mjs" ] || err "the jup package did not contain bin/jup.mjs"

  # §15.43 — the runtime hosting a chain that is about to run out of the store,
  # named here so `self-install` uses the one this script chose rather than
  # re-deriving it from a PATH that may have no `node` on it at all.
  JUP_HOST_RUNTIME="$RUNTIME"
  export JUP_HOST_RUNTIME

  # The handover. From here everything the user sees is jup's own output: where
  # the copy went, which names were linked, and the PATH line to add.
  "$RUNTIME" "$tmp/jup/bin/jup.mjs" self-install "$@"
}

main "$@"
