# jup installer for Windows.
#
#   irm https://jup.unjs.io/install.ps1 | iex
#
# jup is a JavaScript program, so this script does not install jup. It makes
# sure a runtime exists and then hands over to `jup self-install`, which is the
# command that knows where the copy belongs (<home>\self\<version>) and which
# names go on PATH. Everything below is bootstrap.
#
# The runtime is whatever the machine already has. Only when there is neither a
# recent enough Node.js nor a bun does this download one: Node.js, from the same
# signed npm artifact jup's own table names (`node-<target>`), at the version
# jup's table calls node's default. Bootstrapping any other version is what
# leaves a fresh machine holding two copies of Node, this script's and the one
# the first real command fetches.
#
# <home>\node is a sibling of the store's `v1`, so `jup cache clean` cannot take
# it away, and section 10.1 therefore lets the wrappers name it. When the store
# already holds the entry, <home>\node\bin\node.exe is a hard link into it
# rather than a second copy — see New-RuntimeLink.
#
# Unlike install.sh, this half does not *write* the store entry. That needs the
# artifact's npm signature checked first (section 06.1), and Windows ships no
# openssl: the .NET APIs that would do it take spans, which PowerShell cannot
# bind, and the DER-signature overload of VerifyData does not exist at all under
# Windows PowerShell 5.1, which is what `irm | iex` runs. So the download is
# parked at <home>\node and jup fetches and verifies its own store copy on
# first use, as both halves used to.
#
# It is node and not bun for one measured reason: section 10.2's POSIX shims
# dispatch on `basename(process.argv[1])`, and bun sets that to the realpath of
# the script where node leaves the path as invoked. Windows wrappers do not read
# argv that way, but the two installers download the same runtime rather than
# disagreeing about it. A preinstalled bun still runs this script fine.
#
# PATH is left alone. `self-install` chooses the shim directory and prints the
# exact line to add when it is not already there, and two things telling the
# user about PATH is one too many.
#
# Parameters / environment:
#   -Version <spec>         jup version or npm dist-tag (default: latest)
#   -Dir <path>             where the jup and corepack commands go
#   JUP_HOME                jup's store root (default: %LOCALAPPDATA%\jup)
#   JUP_SHIM_DIRECTORY      where `self-install` puts jup and corepack
#   JUP_INSTALL_REGISTRY    npm registry to bootstrap from

[CmdletBinding()]
param(
  [string] $Version = 'latest',
  [string] $Dir,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Rest = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# jup's `engines.node`. A machine whose only Node is older is treated as having
# none: jup would install, and then fail on the first command with an error
# about syntax rather than about the version.
$nodeMinMajor = 22
$nodeMinMinor = 18

# `node.default` from `src/config/table.ts`, stamped by
# `scripts/refresh-table.mjs` (section 16, Built-in table and trust keys) and not
# to be edited by hand. Table data lives in `src/config/`; this is a copy because
# a bootstrap runs before there is a jup to ask, and the stamper is what keeps it
# from becoming a second, drifting source. install.sh carries the same literal.
$nodeVersion = '24.20.0'

# `JUP_NPM_REGISTRY` is jup's own setting (section 11.2) and is honoured here for
# the machine that has to reach a mirror for everything, bootstrap included.
$registry =
  if ($env:JUP_INSTALL_REGISTRY) { $env:JUP_INSTALL_REGISTRY }
  elseif ($env:JUP_NPM_REGISTRY) { $env:JUP_NPM_REGISTRY }
  elseif ($env:COREPACK_NPM_REGISTRY) { $env:COREPACK_NPM_REGISTRY }
  else { 'https://registry.npmjs.org' }

function Fail([string] $message) {
  # `throw` rather than `exit`, so an `irm | iex` run reports the failure and
  # unwinds through the cleanup below instead of closing the user's session.
  throw "jup install: $message"
}

function Note([string] $message) {
  # stderr, so only jup's own output reaches the pipeline.
  [Console]::Error.WriteLine("jup install: $message")
}

# One field of a parsed registry document, or `$null` when it is absent.
# `Set-StrictMode -Version Latest` turns a missing property into an exception, so
# every read of a document this script did not write goes through here.
function Get-Field($object, [string] $name) {
  if ($null -eq $object) { return $null }
  $property = $object.PSObject.Properties[$name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

# Section 7.1's chain, the Windows branch. install.sh is the other half.
function Get-StoreHome {
  if ($env:JUP_HOME) { return $env:JUP_HOME }
  if ($env:COREPACK_HOME) { return $env:COREPACK_HOME }
  $root =
    if ($env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME }
    elseif ($env:LOCALAPPDATA) { $env:LOCALAPPDATA }
    elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'AppData\Local' }
    else { Fail 'neither JUP_HOME nor LOCALAPPDATA is set' }
  return Join-Path $root 'jup'
}

# The `{target}` half of `node-{target}`, spelled the way node's per-host
# packages spell it: `win`, not `win32`.
#
# RuntimeInformation reports the OS architecture rather than the process's, so
# this is still right under a 32-bit or emulated PowerShell on an arm64 machine,
# which PROCESSOR_ARCHITECTURE is not.
function Get-NodeTarget {
  $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  if ($osArch -eq 'X64') { return 'win-x64' }
  if ($osArch -eq 'Arm64') { return 'win-arm64' }
  Fail "unsupported architecture: $osArch (node ships x64 and arm64 builds)"
}

# Is this Node new enough to run jup? Any failure to start is simply "no".
function Test-NodeSupported([string] $path) {
  try { $reported = (& $path --version 2>$null) | Select-Object -First 1 } catch { return $false }
  if ($reported -is [string] -and $reported -match '^v(\d+)\.(\d+)\.') {
    $major = [int] $Matches[1]
    $minor = [int] $Matches[2]
    return $major -gt $nodeMinMajor -or ($major -eq $nodeMinMajor -and $minor -ge $nodeMinMinor)
  }
  return $false
}

# `sha512-<base64>`, the shape npm records in `dist.integrity`.
function Get-Integrity([string] $path) {
  $sha = [System.Security.Cryptography.SHA512]::Create()
  $stream = [System.IO.File]::OpenRead($path)
  try {
    return 'sha512-' + [Convert]::ToBase64String($sha.ComputeHash($stream))
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

# Advisory, not a gate: the registry serves both the metadata and the tarball, so
# a host that could alter one could alter the other. It catches a truncated or
# stale-cached download, which is what actually goes wrong here.
function Assert-Integrity([string] $path, $expected, [string] $what) {
  if (-not $expected) { return }
  $actual = Get-Integrity $path
  if ($actual -ne $expected) {
    Fail "checksum mismatch for $what (expected $expected, got $actual)"
  }
}

# One npm package tarball, unpacked into $into with its `package/` level stripped.
function Expand-Package([string] $package, [string] $spec, [string] $into, [string] $stage) {
  $meta = Invoke-RestMethod -Uri "$registry/$package/$spec" -UseBasicParsing
  $dist = Get-Field $meta 'dist'
  $tarball = Get-Field $dist 'tarball'
  if (-not $tarball) { Fail "$registry/$package/$spec named no tarball" }

  $archive = Join-Path $stage ([System.IO.Path]::GetRandomFileName() + '.tgz')
  # The default progress bar makes Invoke-WebRequest an order of magnitude
  # slower on files this size, and node's is ~40 MB.
  $progress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri $tarball -OutFile $archive -UseBasicParsing
  } finally {
    $ProgressPreference = $progress
  }

  Assert-Integrity $archive (Get-Field $dist 'integrity') $package

  New-Item -ItemType Directory -Path $into -Force | Out-Null
  & tar.exe -xzf $archive -C $into --strip-components=1
  if ($LASTEXITCODE -ne 0) { Fail "cannot unpack $package" }
}

# Download Node.js into <home>\node. A sibling of `v1` and of `self`, for
# `self`'s reason (section 7.11): `jup cache clean` frees cache entries, and a
# runtime the installation depends on is not one. That placement is also what
# makes the runtime nameable in a wrapper (section 10.1).
#
# `$storeRoot` rather than `$home`: PowerShell variable names are case
# insensitive, so a parameter called `$home` is the automatic `$HOME`.
function Install-Node([string] $storeRoot, [string] $stage) {
  $target = Get-NodeTarget
  Note "no Node.js $nodeMinMajor.$nodeMinMinor+ and no bun found; downloading node $nodeVersion for $target"

  $staged = Join-Path $stage 'node'
  Expand-Package "node-$target" $nodeVersion $staged $stage

  $exe = Join-Path $staged 'bin\node.exe'
  if (-not (Test-Path -LiteralPath $exe)) { Fail "node-$target did not contain bin\node.exe" }

  # Only reached when no usable node was found at this path, so whatever is
  # there is a failed or half-finished earlier attempt.
  $dest = Join-Path $storeRoot 'node'
  New-Item -ItemType Directory -Path $storeRoot -Force | Out-Null
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  Move-Item -LiteralPath $staged -Destination $dest

  return (Join-Path $dest 'bin\node.exe')
}

# <home>\node\bin\node.exe, made out of a binary that already exists in the
# store. A hard link, so the second name costs no bytes and the file survives the
# `cache clean` that unlinks the store's name — which is the whole reason
# section 10.1 lets a wrapper name this path. Both names are under <home> and so
# on one volume, which is what NTFS requires; a copy is the fallback, and it
# costs the bytes this exists to save.
function New-RuntimeLink([string] $storeRoot, [string] $source) {
  $dest = Join-Path $storeRoot 'node\bin'
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  $link = Join-Path $dest 'node.exe'
  if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force }
  try {
    New-Item -ItemType HardLink -Path $link -Target $source -ErrorAction Stop | Out-Null
  } catch {
    Copy-Item -LiteralPath $source -Destination $link -Force
  }
  return $link
}

# The runtime to run jup under: the user's own first, then one an earlier run of
# this script left behind. Node before bun because jup's Windows wrappers name
# `node` in their bodies, so a machine with both wants that one.
function Find-Runtime([string] $storeRoot) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($node -and (Test-NodeSupported $node.Path)) { return $node.Path }

  $bun = Get-Command bun.exe -ErrorAction SilentlyContinue
  if ($bun) { return $bun.Path }

  # One an earlier run parked here, version checked like the ones on PATH rather
  # than taken on sight: an installer old enough to have left a different major
  # is what $nodeMinMajor is here to catch, and adopting it forever is how a
  # machine never ends up running the version jup's table names.
  $sidecar = Join-Path $storeRoot 'node\bin\node.exe'
  if ((Test-Path -LiteralPath $sidecar) -and (Test-NodeSupported $sidecar)) { return $sidecar }

  # The store may already hold the entry a download would produce — an earlier
  # `jup cache install -g node`, or an image seeded by `jup pack`. It cannot be named
  # directly, because section 10.2 forbids naming a runtime inside `v1` that
  # `cache clean` exists to delete, but linking it out is free.
  $cached = Join-Path $storeRoot "v1\node\$nodeVersion\bin\node.exe"
  if ((Test-Path -LiteralPath (Join-Path $storeRoot "v1\node\$nodeVersion\.jup")) -and
      (Test-Path -LiteralPath $cached) -and (Test-NodeSupported $cached)) {
    try { return (New-RuntimeLink $storeRoot $cached) } catch { }
  }

  return $null
}

# tar.exe has shipped with Windows since 10 1803 and is libarchive, so it reads
# a gzipped tarball without a separate gzip. There is no PowerShell fallback:
# Expand-Archive is zip-only.
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
  Fail 'tar.exe was not found. It ships with Windows 10 1803 and later; on an older system, install jup with "npm install -g jup" instead.'
}

$storeHome = Get-StoreHome
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('jup-install-' + [System.Guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  $runtime = Find-Runtime $storeHome
  if (-not $runtime) { $runtime = Install-Node $storeHome $tmp }

  $unpacked = Join-Path $tmp 'jup'
  Expand-Package 'jup' $Version $unpacked $tmp

  $entry = Join-Path $unpacked 'bin\jup.mjs'
  if (-not (Test-Path -LiteralPath $entry)) { Fail 'the jup package did not contain bin\jup.mjs' }

  # Section 15.43 tier 1 — the runtime hosting a chain that is about to run out
  # of the store, named here so `self-install` uses the one this script chose
  # rather than re-deriving it from a PATH that may have no `node` on it at all.
  $env:JUP_HOST_RUNTIME = $runtime

  $arguments = @('self-install')
  if ($Dir) { $arguments += @('--install-directory', $Dir) }
  if ($Rest) { $arguments += $Rest }

  Note "installing jup with $runtime"

  # The handover. From here everything the user sees is jup's own output: where
  # the copy went, which names were linked, and the PATH line to add.
  & $runtime $entry @arguments
  if ($LASTEXITCODE -ne 0) { Fail "self-install exited with $LASTEXITCODE" }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
