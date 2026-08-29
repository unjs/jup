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
# recent enough Node.js nor a bun does this download one: bun, from the same
# signed npm artifact jup's own table names (`@oven/bun-<target>`), into
# <home>\bun beside the store rather than anywhere on the user's PATH.
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

# The `{target}` half of `@oven/bun-{target}`, spelled the way bun spells it.
# RuntimeInformation reports the OS architecture rather than the process's, so
# this is still right under a 32-bit or emulated PowerShell on an arm64 machine,
# which PROCESSOR_ARCHITECTURE is not.
function Get-BunTarget {
  $osArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  if ($osArch -eq 'X64') { return 'windows-x64' }
  if ($osArch -eq 'Arm64') { return 'windows-aarch64' }
  Fail "unsupported architecture: $osArch (bun ships x64 and arm64 builds)"
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
  # slower on files this size, and bun's is ~40 MB.
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

# Download bun into <home>\bun. A sibling of `v1` and of `self`, for `self`'s
# reason (section 7.11): `jup cache clean` frees cache entries, and a runtime the
# installation depends on is not one.
#
# `$storeRoot` rather than `$home`: PowerShell variable names are case
# insensitive, so a parameter called `$home` is the automatic `$HOME`.
function Install-Bun([string] $storeRoot, [string] $stage) {
  $target = Get-BunTarget
  Note "no Node.js $nodeMinMajor.$nodeMinMinor+ and no bun found; downloading bun for $target"

  $staged = Join-Path $stage 'bun'
  Expand-Package "@oven/bun-$target" 'latest' $staged $stage

  $exe = Join-Path $staged 'bin\bun.exe'
  if (-not (Test-Path -LiteralPath $exe)) { Fail "@oven/bun-$target did not contain bin\bun.exe" }

  # Only reached when no usable bun was found at this path, so whatever is there
  # is a failed or half-finished earlier attempt.
  $dest = Join-Path $storeRoot 'bun'
  New-Item -ItemType Directory -Path $storeRoot -Force | Out-Null
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  Move-Item -LiteralPath $staged -Destination $dest

  return (Join-Path $dest 'bin\bun.exe')
}

# The runtime to run jup under: the user's own first, then one an earlier run of
# this script left behind. Node before bun because jup's Windows wrappers name
# `node` in their bodies, so a machine with both wants that one.
function Find-Runtime([string] $storeRoot) {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($node -and (Test-NodeSupported $node.Path)) { return $node.Path }

  $bun = Get-Command bun.exe -ErrorAction SilentlyContinue
  if ($bun) { return $bun.Path }

  $sidecar = Join-Path $storeRoot 'bun\bin\bun.exe'
  if (Test-Path -LiteralPath $sidecar) { return $sidecar }

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
  if (-not $runtime) { $runtime = Install-Bun $storeHome $tmp }

  $unpacked = Join-Path $tmp 'jup'
  Expand-Package 'jup' $Version $unpacked $tmp

  $entry = Join-Path $unpacked 'bin\jup.mjs'
  if (-not (Test-Path -LiteralPath $entry)) { Fail 'the jup package did not contain bin\jup.mjs' }

  # Section 15.43 — the runtime hosting a chain that is about to run out of the
  # store, named here so `self-install` uses the one this script chose rather
  # than re-deriving it from a PATH that may have no `node` on it at all.
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
