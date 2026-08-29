#!/bin/sh
# jup installer for macOS, Linux, and other POSIX systems.
#
#   curl -fsSL https://jup.unjs.io/install.sh | sh
#
# It downloads the standalone binary for this machine from the release mirror
# under https://jup.unjs.io/r/, checks it against the digest GitHub recorded for
# that asset, and puts it in the same directory `jup enable` would put shims in:
# $XDG_BIN_HOME or ~/.local/bin. That is deliberate — one directory on PATH ends
# up holding `jup` and the tool commands it links, rather than two.
#
# The binary carries its own runtime, so nothing here needs Node.js or npm. That
# is the whole reason this script exists next to `npm install -g jup`.
#
# Environment:
#   JUP_INSTALL_DIR       where to put the binary (default: as above)
#   JUP_INSTALL_BASE_URL  mirror to download from (default: https://jup.unjs.io)
#
# Options: --dir <path> (same as JUP_INSTALL_DIR), --help.
#
# Everything is inside main(), called on the last line, so a download that is
# cut short cannot run half a script.

set -eu

BASE_URL="${JUP_INSTALL_BASE_URL:-https://jup.unjs.io}"

err() {
  echo "jup install: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [--dir <path>]

  --dir <path>  Install jup here instead of $XDG_BIN_HOME or ~/.local/bin.
  --help        Show this message.
EOF
}

# `uname` names for the eight targets `pnpm compile` builds.
detect_target() {
  os=$(uname -s)
  arch=$(uname -m)

  case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) err "unsupported architecture: $arch (jup ships x64 and arm64 binaries)" ;;
  esac

  case "$os" in
  Darwin) echo "darwin-$arch" ;;
  Linux)
    # glibc and musl need different binaries, and a musl system running the
    # glibc build fails at exec with a message about a missing loader rather
    # than anything that names the cause. `ldd --version` writes its banner to
    # stderr on musl and exits non-zero, so both streams are read and the exit
    # status ignored; the loader check is the fallback for systems with no ldd.
    if (ldd --version 2>&1 || true) | grep -qi musl ||
      [ -n "$(find /lib /lib64 -maxdepth 1 -name 'ld-musl-*' -print -quit 2>/dev/null)" ]; then
      echo "linux-$arch-musl"
    else
      echo "linux-$arch"
    fi
    ;;
  *)
    err "unsupported system: $os (this script covers macOS and Linux; on Windows use install.ps1)"
    ;;
  esac
}

# §10.4's default, minus the parts only `enable` can answer: the alternates it
# considers are about which directory already holds shims, and none do yet.
default_dir() {
  if [ "$(uname -s)" != Darwin ] && [ -n "${XDG_BIN_HOME:-}" ]; then
    case "$XDG_BIN_HOME" in
    /*)
      echo "$XDG_BIN_HOME"
      return
      ;;
    esac
  fi
  [ -n "${HOME:-}" ] || err "HOME is not set; pass --dir <path>"
  echo "$HOME/.local/bin"
}

download() {
  # -f so a 404 is a failure rather than an HTML page written to disk.
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    err "neither curl nor wget is available"
  fi
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    err "neither curl nor wget is available"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | sed 's/.*= *//'
  fi
}

# The digest GitHub recorded for the asset, read out of the mirror's index.json
# without a JSON parser: quotes, spaces, and commas are stripped, then the first
# `digest` line after the matching `name` line is the answer.
published_digest() {
  # Errors are dropped rather than reported: a mirror with no index is a
  # verification this run skips, not a failure to show the user.
  fetch "$BASE_URL/r/index.json" 2>/dev/null | tr -d ' ",' | awk -F: -v n="$1" '
    $1 == "name" && $2 == n { found = 1 }
    found && $1 == "digest" { print $3; exit }
  '
}

main() {
  dir=""
  while [ $# -gt 0 ]; do
    case "$1" in
    --dir)
      [ $# -ge 2 ] || err "--dir needs a path"
      dir="$2"
      shift 2
      ;;
    --dir=*)
      dir="${1#--dir=}"
      shift
      ;;
    -h | --help)
      usage
      return 0
      ;;
    *) err "unknown option: $1" ;;
    esac
  done

  [ -n "$dir" ] || dir="${JUP_INSTALL_DIR:-$(default_dir)}"

  target=$(detect_target)
  asset="jup-$target.tar.xz"

  command -v tar >/dev/null 2>&1 || err "tar is required"

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/jup-install.XXXXXX") || err "cannot create a temporary directory"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  echo "jup install: downloading $asset"
  download "$BASE_URL/r/$asset" "$tmp/$asset" ||
    err "download failed: $BASE_URL/r/$asset"

  # Advisory, not a gate: the mirror serves both the archive and the index, so a
  # host that could alter one could alter the other. It catches a truncated or
  # stale-cached download, which is what actually goes wrong here.
  expected=$(published_digest "$asset" || true)
  actual=$(sha256_of "$tmp/$asset" || true)
  if [ -n "$expected" ] && [ -n "$actual" ]; then
    [ "$expected" = "$actual" ] ||
      err "checksum mismatch for $asset (expected $expected, got $actual)"
  fi

  # -J where it exists, `xz` piped in where tar has no LZMA support of its own.
  if ! tar -xJf "$tmp/$asset" -C "$tmp" 2>/dev/null; then
    command -v xz >/dev/null 2>&1 || err "tar cannot read .tar.xz and xz is not installed"
    xz -dc "$tmp/$asset" | tar -xf - -C "$tmp" || err "cannot unpack $asset"
  fi
  [ -f "$tmp/jup-$target" ] || err "$asset did not contain jup-$target"

  mkdir -p "$dir" || err "cannot create $dir"
  [ -w "$dir" ] || err "$dir is not writable"

  # Written beside the destination and renamed over it, so an interrupted
  # install cannot leave a half-written `jup`, and a running one is replaced
  # rather than truncated under itself.
  chmod 755 "$tmp/jup-$target"
  mv -f "$tmp/jup-$target" "$dir/.jup.new" || err "cannot write to $dir"
  mv -f "$dir/.jup.new" "$dir/jup" || err "cannot install $dir/jup"

  version=$("$dir/jup" --version 2>/dev/null || echo "?")
  echo "jup install: installed jup $version to $dir/jup"

  case ":${PATH:-}:" in
  *":$dir:"*) ;;
  *)
    echo
    echo "  $dir is not on PATH. Add it:"
    echo
    echo "    export PATH=\"$dir:\$PATH\""
    echo
    ;;
  esac

  # Not `jup enable`: shims point at a stub that imports the entry module, and
  # a single-file binary has no such file on disk (§10.2). Linking the tool
  # commands still needs the npm package.
  echo "Next: run 'jup use pnpm@12' in a project, or 'jup --help'."
}

main "$@"
